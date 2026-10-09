import { Logger } from '@nestjs/common';
import { Temporal, err, ok } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  ContentHash,
  Id,
  IdGenerator,
  Result,
} from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_BUSINESS_IDENTITY_EDIT } from '../../contracts/permissions';
import { addressFromJson } from '../../domain/address';
import {
  parseBusinessIdentifier,
  type NormalisedIdentifier,
} from '../../domain/business-identifier';
import {
  CONTENT_SCHEMA_VERSION,
  evaluateSubmission,
  newPendingRevision,
  registerSnapshotOf,
  type BusinessFileContent,
  type BusinessFileRevision,
  type RegisterSnapshot,
  type SubmissionSnapshot,
} from '../../domain/business-file-revision';
import { SUBMIT_LIMITS } from '../../domain/rate-limits';
import { blocksSubmit, registerStateOf, type RegisterCheck } from '../../domain/register-check';
import type { Sealed, SealedField } from '../../domain/sealed';
import type { DraftPart } from '../../domain/seller-file';
import { parseShopSlug } from '../../domain/shop-slug';
import {
  draftRequirementsOf,
  logDraftOutcome,
  reserveRateLimits,
  sellerActorOf,
  type AccessUnavailable,
  type DraftAccessDenied,
  type RequestThrottled,
  type SellersUnavailable,
} from '../draft/draft-support';
import type { DraftConflict, FileNotFound } from '../draft/draft-view';
import type { BusinessFileRevisionRepository } from '../ports/business-file-revision.repository';
import type { BusinessIdentifierSchemes } from '../ports/business-identifier-scheme';
import type { RevisionContentSealer, SealedRevision } from '../ports/revision-content-sealer';
import type { SellerAccessReader } from '../ports/seller-access-reader';
import type { SellerFileCipher } from '../ports/seller-file-cipher';
import type { SellerFileRepository } from '../ports/seller-file.repository';
import type { AddressFormats, ServiceAreas } from '../ports/seller-market-formats';
import type { SellerMarketPolicy } from '../ports/seller-market-policy';
import type { ShopSlugRepository } from '../ports/shop-slug.repository';
import {
  lookupDue,
  lookupPlanOf,
  reserveLookupQuota,
  runLookup,
  type LookupLimitReached,
  type LookupPlan,
  type RegisterLookupDependencies,
} from '../register/register-lookup';

/** The seller submits the saved draft; the request carries nothing but the origin of the call. */
export interface MyFileSubmitInput {
  /**
   * The network origin of the request (cut by the controller from the resolved client address,
   * never from the body), for the register lookup's per-origin quota. Null or absent when it
   * cannot be read: a submit that would call the register then fails closed.
   */
  readonly origin?: string | null;
}

export interface MyFileSubmitted {
  readonly revisionNo: number;
  /** The file's version after the submission. */
  readonly version: number;
  readonly submittedAt: Temporal.Instant;
  /** The file had an earlier revision: another try, not a first application. */
  readonly resubmission: boolean;
}

export type MyFileSubmitFailure =
  | { readonly code: 'file.incomplete'; readonly missing: readonly DraftPart[] }
  | { readonly code: 'address.outside-service-area' }
  | { readonly code: 'file.already-submitted' }
  | { readonly code: 'file.change-request-required' }
  | { readonly code: 'seller-access.wrong-state' }
  | { readonly code: 'identifier.not-matched' }
  | { readonly code: 'slug.format' | 'slug.reserved' | 'slug.taken' }
  | LookupLimitReached
  | DraftAccessDenied
  | AccessUnavailable
  | RequestThrottled
  | SellersUnavailable
  | FileNotFound
  | DraftConflict;

export interface MyFileSubmitDependencies extends RegisterLookupDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly slugs: ShopSlugRepository;
  readonly revisions: BusinessFileRevisionRepository;
  readonly outbox: OutboxWriter;
  readonly policy: SellerMarketPolicy;
  readonly identifierSchemes: BusinessIdentifierSchemes;
  readonly areas: ServiceAreas;
  readonly addressFormats: AddressFormats;
  readonly cipher: SellerFileCipher;
  readonly sealer: RevisionContentSealer;
  readonly accessReader: SellerAccessReader;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/**
 * `my-file.submit` (sellers design 3.1, 6.2, 7.3; slice 5b): the Seller Owner sends the saved draft
 * for review. Rule `permissions [sellers.business-identity.edit]`, allowed while not approved;
 * the owner is `ActorContext.sellerId`. In order:
 *
 * 1. the submissions limit of 6.5 (5 per 24 hours per file) is reserved before any work;
 * 2. `identity`'s access state is read outside any unit: only `pending` may submit (a rejected
 *    seller's re-application waits for slice 7b and `identity`'s re-apply call);
 * 3. one read-only unit loads the file, its pending and latest revisions, the stored register
 *    result of the draft's number and the tax answer; a pending revision is
 *    `file.already-submitted`, a file with an approved revision `file.change-request-required`;
 * 4. completeness and the ServiceArea are judged against the Market's current configuration (not
 *    the stored hint) and the slug is parsed again against today's reserved words;
 * 5. a definite negative of the register refuses (AC 31); a value with no current result is
 *    asked of the register under the same quotas as a save (AC 32: an unavailable answer does
 *    not block);
 * 6. the content is assembled from the decrypted draft and sealed, outside any unit;
 * 7. one read-write unit writes the submission: the file row is first compare-and-set on the
 *    version this use case judged (and so locked until commit), so a save, a withdrawal or another
 *    submission that committed in between makes this one `conflict.stale`, and one that starts
 *    later waits for this commit and then withdraws the new revision itself. Only then are the
 *    stored register result read (the snapshot is bound to that exact version), the revision
 *    inserted (one pending per file and the revision number are database keys), the slug held (T1,
 *    I-S1) and `business-file-submitted.v1` appended.
 *
 * Any refusal rolls the unit back. The reviewer notice is the event handler's (7.5), never in
 * this request. A seller-side write is not offered in acting-as; the session has no acting-as
 * flag yet (see the slice 4a note in the data design).
 */
export class MyFileSubmit extends UseCase<MyFileSubmitInput, MyFileSubmitted, MyFileSubmitFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.my-file-submit',
    rule: { kind: 'permissions', allOf: [SELLERS_BUSINESS_IDENTITY_EDIT.key] },
    whenSellerNotApproved: 'allow',
  };

  readonly #logger = new Logger('MyFileSubmit');

  constructor(
    gate: UseCaseGate,
    private readonly deps: MyFileSubmitDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: MyFileSubmitInput,
  ): Promise<Result<MyFileSubmitted, MyFileSubmitFailure>> {
    const result = await this.submit(context, input ?? {});
    logDraftOutcome(
      'my-file-submit',
      context,
      sellerActorOf(context)?.sellerId ?? null,
      result.ok ? 'submitted' : result.error.code,
    );
    return result;
  }

  private unavailable(context: CallContext, step: string, error: unknown) {
    this.#logger.error({
      msg: `sellers.my-file-submit.${step}`,
      error: error instanceof Error ? error.name : 'unknown',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'sellers.unavailable' } as const);
  }

  private async submit(
    context: CallContext,
    input: MyFileSubmitInput,
  ): Promise<Result<MyFileSubmitted, MyFileSubmitFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, files, revisions, policy, identifierSchemes, areas, addressFormats } =
      this.deps;
    const { cipher, sealer, clock } = this.deps;

    const reserved = await reserveRateLimits(this.deps, context, SUBMIT_LIMITS, owner.sellerId);
    if (!reserved.ok) return reserved;

    const requirements = draftRequirementsOf(policy, market);
    const scheme = identifierSchemes.schemeOf(market);
    const format = addressFormats.formatOf(market);
    const reservedWords = policy.reservedWords(market);
    if (requirements === null || scheme === null || format === null || reservedWords === null) {
      return err({ code: 'sellers.unavailable' });
    }
    let plan: LookupPlan | null;
    try {
      plan = lookupPlanOf(this.deps, market);
    } catch (error) {
      return this.unavailable(context, 'lookup-unavailable', error);
    }

    let access;
    try {
      access = await this.deps.accessReader.accessOf(context, owner.sellerId);
    } catch (error) {
      return this.unavailable(context, 'access-unavailable', error);
    }
    if (access === null) return err({ code: 'file.not-found' });

    let loaded;
    try {
      loaded = await unitOfWork.run(
        market,
        async () => {
          const file = await files.findById(market, owner.sellerId);
          if (file === null) return ok(null);
          const pending = await revisions.findPending(market, owner.sellerId);
          const latest = await revisions.findLatest(market, owner.sellerId);
          const index = file.state.draft.identifier?.index ?? null;
          const existing =
            plan !== null && index !== null
              ? await this.deps.registerChecks.find(market, owner.sellerId, index)
              : null;
          const tax = await this.deps.taxProfiles.findBySellerId(market, owner.sellerId);
          return ok({ file, pending, latest, existing, tax });
        },
        { readOnly: true },
      );
    } catch (error) {
      return this.unavailable(context, 'read-failed', error);
    }
    if (!loaded.ok || loaded.value === null) return err({ code: 'file.not-found' });
    const { file: current, pending, latest: latestRevision, existing, tax } = loaded.value;

    if (current.state.hasApprovedRevision) return err({ code: 'file.change-request-required' });
    if (access !== 'pending') return err({ code: 'seller-access.wrong-state' });
    if (pending !== null) return err({ code: 'file.already-submitted' });

    const missing = current.missing(requirements);
    if (missing.length > 0) return err({ code: 'file.incomplete', missing });
    const { draft } = current.state;

    // The slug again, against today's reserved words: the words may have grown since the save.
    const slug = parseShopSlug(draft.slug, reservedWords);
    if (!slug.ok) return err({ code: slug.error.code });

    // Decrypt the draft: one key unwrap per field, after the read unit and outside any unit.
    let content: BusinessFileContent;
    let identifier: { readonly scheme: string; readonly value: NormalisedIdentifier } | null = null;
    let postcode: string;
    try {
      let destroyed = false;
      const open = async <F extends SealedField>(
        field: F,
        sealed: Sealed<F> | null,
      ): Promise<string | null> => {
        if (sealed === null) return null;
        const opened = await cipher.open(market, owner.sellerId, field, sealed);
        if (!opened.ok) destroyed = true;
        return opened.ok ? opened.value : null;
      };
      const businessName = await open('business-name', draft.businessName);
      const phone = await open('phone', draft.phone);
      const contactEmail = await open('contact-email', draft.contactEmail);
      const addressJson = await open('address', draft.address);
      const registeredJson = await open('registered-address', draft.registeredAddress);
      const identifierText =
        draft.identifier?.scheme === requirements.identifierScheme
          ? await open('identifier', draft.identifier.sealed)
          : null;
      if (
        destroyed ||
        businessName === null ||
        phone === null ||
        addressJson === null ||
        draft.storeName === null
      ) {
        return err({ code: 'sellers.unavailable' });
      }
      const address = addressFromJson(addressJson, format);
      const registered = registeredJson === null ? null : addressFromJson(registeredJson, format);
      if (identifierText !== null) {
        const parsed = parseBusinessIdentifier(identifierText, scheme);
        if (!parsed.ok) return err({ code: 'file.incomplete', missing: ['identifier'] });
        identifier = parsed.value;
      }
      postcode = address.postcode;
      content = {
        schemaVersion: CONTENT_SCHEMA_VERSION,
        storeName: draft.storeName.name,
        businessName,
        phone,
        contactEmail,
        address: address.fields,
        registeredAddress: registered?.fields ?? null,
        identifier,
        registeredForIndirectTax: tax?.asOf(clock.now())?.registeredForIndirectTax ?? null,
      };
    } catch (error) {
      return this.unavailable(context, 'decrypt-failed', error);
    }

    // The area now, from the saved postcode (an area may have closed or opened since the save).
    const area = areas.areaFor(market, postcode);
    const evaluated = evaluateSubmission(
      { ...draft, serviceAreaCode: area?.code ?? null },
      requirements,
      area?.sellerOnboardingEnabled ?? null,
    );
    if (!evaluated.ok) {
      return evaluated.error.code === 'service-area.outside'
        ? err({ code: 'address.outside-service-area' })
        : err(evaluated.error);
    }
    const place = evaluated.value;

    // Sealed before the register is consulted: the keyed hash of the content tells whether the draft
    // is the one an earlier revision was submitted with (Ali A: no new lookup for an unchanged one).
    let sealed: SealedRevision;
    try {
      const result = await sealer.seal(market, owner.sellerId, content);
      if (!result.ok) return err({ code: 'sellers.unavailable' });
      sealed = result.value;
    } catch (error) {
      return this.unavailable(context, 'seal-failed', error);
    }

    // The register (design 7.7): a definite negative refuses; a value with no current result is
    // asked now, under the quotas of a save.
    const index = place.identifierIndex;
    let reusedCheckedAt: Temporal.Instant | null = null;
    if (plan !== null && index !== null && identifier !== null) {
      const now = clock.now();
      // An unchanged draft (same keyed content hash as the latest revision, whose snapshot relied
      // on this very row) keeps its result: withdrawing and submitting again moves the file's
      // version and stamp but not the draft, so the version rule does not apply (Ali A).
      const reuse = reusableResult(existing, latestRevision, sealed.contentHash);
      reusedCheckedAt = reuse ? (existing?.checkedAt ?? null) : null;
      const basis = judgedBasis(
        existing,
        reuse,
        current.state.lastChangedAt,
        current.state.version,
      );
      const stateOf = (check: typeof existing) =>
        registerStateOf(check, now, plan.settings.maxResultAgeDays, basis.changedAt, basis.version);
      if (blocksSubmit(stateOf(existing))) return err({ code: 'identifier.not-matched' });
      if (lookupDue(existing, now, plan.settings, basis.changedAt, basis.version)) {
        const quota = await reserveLookupQuota(
          this.deps,
          context,
          { accountId: owner.accountId, origin: input.origin ?? null },
          plan.settings,
        );
        if (!quota.ok) return quota;
        if (quota.value === 'go') {
          let snapshotAt = clock.now();
          if (Temporal.Instant.compare(snapshotAt, current.state.lastChangedAt) < 0) {
            snapshotAt = current.state.lastChangedAt;
          }
          const check = await runLookup(this.deps, context, plan, {
            sellerId: owner.sellerId,
            scheme: identifier.scheme,
            identifier: identifier.value,
            index,
            file: current,
            snapshotAt,
            by: { kind: 'seller', accountId: owner.accountId },
          });
          reusedCheckedAt = null;
          if (check !== null && blocksSubmit(stateOf(check))) {
            return err({ code: 'identifier.not-matched' });
          }
        }
      }
    }

    return this.write(context, owner, {
      judgedVersion: current.state.version,
      slugText: slug.value,
      place,
      sealed,
      plan,
      reusedCheckedAt,
    });
  }

  private async write(
    context: CallContext,
    owner: { readonly sellerId: Id<'Seller'>; readonly accountId: Id<'Account'> },
    judged: {
      readonly judgedVersion: number;
      readonly slugText: Parameters<ShopSlugRepository['hold']>[1]['slug'];
      readonly place: SubmissionSnapshot;
      readonly sealed: SealedRevision;
      readonly plan: LookupPlan | null;
      /** The `checkedAt` of the stored row judged reusable for an unchanged draft, or null. */
      readonly reusedCheckedAt: Temporal.Instant | null;
    },
  ): Promise<Result<MyFileSubmitted, MyFileSubmitFailure>> {
    const { market } = context;
    const { unitOfWork, files, revisions, slugs, outbox, ids, clock } = this.deps;
    return unitOfWork.run<MyFileSubmitted, MyFileSubmitFailure>(market, async () => {
      const file = await files.findById(market, owner.sellerId);
      if (file === null) return err({ code: 'file.not-found' });
      // The version this use case judged is the only one it may submit; a save, a withdrawal or a
      // submission that got here first has moved it.
      if (file.state.version !== judged.judgedVersion) return err({ code: 'conflict.stale' });
      const changedAt = file.state.lastChangedAt;
      const judgedAt = file.state.version;
      const now = clock.now();

      const latest = await revisions.findLatest(market, owner.sellerId);
      if (latest !== null && latest.status === 'pending') {
        return err({ code: 'file.already-submitted' });
      }
      const revisionId = ids.next<'BusinessFileRevision'>();
      const resubmission = latest !== null;
      const recorded = file.recordSubmission(
        { revisionId, kind: 'onboarding', authorKind: 'seller', resubmission },
        now,
      );
      if (!recorded.ok) return recorded;
      // The row lock: from here no other write of this file runs until this unit ends.
      if (!(await files.recordChange(market, file))) return err({ code: 'conflict.stale' });

      // The stored result is read under the lock and judged for the exact version locked.
      let register: RegisterSnapshot = {
        outcome: 'not-performed',
        mismatches: [],
        checkedAt: null,
      };
      const index = judged.place.identifierIndex;
      if (judged.plan !== null && index !== null) {
        const check = await this.deps.registerChecks.find(market, owner.sellerId, index);
        // The row judged reusable is reused only if it is still that very row.
        const reuse =
          check !== null &&
          judged.reusedCheckedAt !== null &&
          Temporal.Instant.compare(check.checkedAt, judged.reusedCheckedAt) === 0;
        const basis = judgedBasis(check, reuse, changedAt, judgedAt);
        const maxAge = judged.plan.settings.maxResultAgeDays;
        if (blocksSubmit(registerStateOf(check, now, maxAge, basis.changedAt, basis.version))) {
          return err({ code: 'identifier.not-matched' });
        }
        register = registerSnapshotOf(check, now, maxAge, basis.changedAt, basis.version);
      }

      const revision = newPendingRevision({
        id: revisionId,
        sellerId: owner.sellerId,
        kind: 'onboarding',
        revisionNo: (latest?.revisionNo ?? 0) + 1,
        authorKind: 'seller',
        authorAccountId: owner.accountId,
        snapshot: judged.place,
        contentHash: judged.sealed.contentHash,
        register,
        now,
      });
      const added = await revisions.add(market, revision, judged.sealed);
      if (!added.ok) {
        if (added.error.code === 'revision.pending-exists') {
          return err({ code: 'file.already-submitted' });
        }
        if (added.error.code === 'revision.number-taken') return err({ code: 'conflict.stale' });
        throw new Error('my-file-submit: the revision id was taken');
      }

      const held = await slugs.hold(market, {
        id: ids.next(),
        sellerId: owner.sellerId,
        slug: judged.slugText,
        now,
      });
      if (held === 'taken') return err({ code: 'slug.taken' });

      await outbox.append(context, file.pendingEvents);
      return ok({
        revisionNo: revision.revisionNo,
        version: file.state.version,
        submittedAt: now,
        resubmission,
      });
    });
  }
}

/**
 * Whether the stored result may be reused for this draft: the latest revision (whatever its
 * status) has the same keyed content hash, so the draft is what was submitted then, and its
 * snapshot relied on exactly this row. Then a new version of the file (a withdrawal, a
 * submission) is not a change of the draft. A result that aged out or is `unavailable` still
 * follows the usual rules of age; only the version and stamp rule is set aside.
 */
function reusableResult(
  existing: RegisterCheck | null,
  latest: BusinessFileRevision | null,
  contentHash: ContentHash,
): boolean {
  return (
    existing !== null &&
    latest !== null &&
    latest.contentHash === contentHash &&
    latest.register.checkedAt !== null &&
    Temporal.Instant.compare(latest.register.checkedAt, existing.checkedAt) === 0
  );
}

/** The file stamp and version to judge a row by: its own when the draft is unchanged. */
function judgedBasis(
  check: RegisterCheck | null,
  reuse: boolean,
  changedAt: Temporal.Instant,
  version: number,
): { readonly changedAt: Temporal.Instant; readonly version: number } {
  return reuse && check !== null
    ? { changedAt: check.checkedAt, version: check.comparedFileVersion }
    : { changedAt, version };
}
