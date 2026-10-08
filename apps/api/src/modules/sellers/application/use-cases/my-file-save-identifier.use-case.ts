import { Logger } from '@nestjs/common';
import { Temporal, err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_BUSINESS_IDENTITY_EDIT } from '../../contracts/permissions';
import {
  parseBusinessIdentifier,
  type DraftIdentifier,
  type IdentifierInvalid,
} from '../../domain/business-identifier';
import { SAVE_LIMITS } from '../../domain/rate-limits';
import type { RegisterCheck, SellerRegisterResult } from '../../domain/register-check';
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
import {
  draftSaved,
  isBlank,
  type DraftConflict,
  type DraftSaved,
  type FileNotFound,
} from '../draft/draft-view';
import type { BusinessIdentifierSchemes } from '../ports/business-identifier-scheme';
import type { IdentifierIndex } from '../ports/identifier-index';
import {
  lookupDue,
  lookupPlanOf,
  reserveLookupQuota,
  runLookup,
  sellerResultOf,
  type LookupLimitReached,
  type LookupPlan,
  type QuotaVerdict,
  type RegisterLookupDependencies,
} from '../register/register-lookup';
import type { SellerFileCipher } from '../ports/seller-file-cipher';
import type { SellerFile } from '../../domain/seller-file';
import type { SellerFileRepository } from '../ports/seller-file.repository';
import type { SellerMarketPolicy } from '../ports/seller-market-policy';

/**
 * The identifier as the seller sends it (UX F13). The request has no seller id, Market or scheme:
 * the scheme is the Market's. An absent, null or blank value clears the saved identifier.
 */
export interface MyFileSaveIdentifierInput {
  readonly identifier?: unknown;
  /**
   * The network origin of the request (IPv4 address or IPv6 /64, cut by the controller from the
   * socket; never from the body), for the per-origin lookup quota. Null or absent when it cannot
   * be read: a save that would call the register then fails closed (`access.unavailable`).
   */
  readonly origin?: string | null;
}

/**
 * A saved identifier and what the register said about it, as the seller may see it (design 7.7,
 * brief s5): `matched`, `not-matched` (one message for not found and cancelled) or
 * `could-not-be-checked`; null when the Market has no register lookup, the value was cleared, or
 * the file holds no result. Never a register value or a mismatch flag.
 */
export interface IdentifierSaved extends DraftSaved {
  readonly registerResult: SellerRegisterResult | null;
}

export type MyFileSaveIdentifierFailure =
  | { readonly code: IdentifierInvalid }
  | { readonly code: 'file.change-request-required' }
  | LookupLimitReached
  | DraftAccessDenied
  | AccessUnavailable
  | RequestThrottled
  | SellersUnavailable
  | FileNotFound
  | DraftConflict;

export interface MyFileSaveIdentifierDependencies extends RegisterLookupDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly policy: SellerMarketPolicy;
  readonly identifierSchemes: BusinessIdentifierSchemes;
  readonly identifierIndex: IdentifierIndex;
  readonly cipher: SellerFileCipher;
  readonly clock: Clock;
}

/**
 * `my-file.save-identifier` (sellers design 6.2, 8.1, 8.2; slice 3): the Seller Owner saves the
 * business identifier of the draft. Rule `permissions [sellers.business-identity.edit]`, allowed
 * while the seller is not approved; the owner is `ActorContext.sellerId`. In order:
 *
 * 1. the saves limit of 6.5 is reserved before any work; a store that cannot answer is
 *    `access.unavailable`;
 * 2. the value is parsed against the Market's scheme (`identifier.format`, `identifier.checksum`);
 *    a blank value clears the saved one, which only leaves the draft complete in a Market that
 *    does not require an identifier;
 * 3. outside the unit, the normalised value is sealed under the seller's key and its keyed index
 *    is computed (the index is bound to the Market and the scheme, design 8.2);
 * 4. one read-write unit loads the file, saves the identifier in the aggregate (a refused file with
 *    an approved revision, completeness recomputed against the Market's rule) and writes it over
 *    the version it read (`conflict.stale` on a lost race). Saving the same value again is a
 *    no-op: no write, no new version.
 *
 * The register lookup (slice 4a, design 7.7) follows the save of a value that is new to the
 * file, or whose result has aged out, in a Market whose adapter reaches a register. Its quotas
 * (the account's new values, the origin's calls, the Market's budget) are reserved before the
 * save and before the call; the account limit refuses the save (`lookup.limit`) and creates no
 * result; the call is made outside any unit; the answer is kept per file and value, and the
 * seller sees only `matched`, `not-matched` or `could-not-be-checked`. A Market with the `none`
 * adapter reserves nothing and calls nothing. A seller-side write is not offered in acting-as;
 * the session has no acting-as flag yet (see the slice 4a note in the data design).
 *
 * Uniqueness is not decided here: a draft gives no right to a number (brief s7); the claim is
 * taken when a reviewer approves (7a-decide). The seller never learns whether another seller
 * holds the value. The value never reaches a log, an error or an event.
 */
export class MyFileSaveIdentifier extends UseCase<
  MyFileSaveIdentifierInput,
  IdentifierSaved,
  MyFileSaveIdentifierFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.my-file-save-identifier',
    rule: { kind: 'permissions', allOf: [SELLERS_BUSINESS_IDENTITY_EDIT.key] },
    whenSellerNotApproved: 'allow',
  };

  readonly #logger = new Logger('MyFileSaveIdentifier');

  constructor(
    gate: UseCaseGate,
    private readonly deps: MyFileSaveIdentifierDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: MyFileSaveIdentifierInput,
  ): Promise<Result<IdentifierSaved, MyFileSaveIdentifierFailure>> {
    const result = await this.save(context, input ?? {});
    logDraftOutcome(
      'my-file-save-identifier',
      context,
      sellerActorOf(context)?.sellerId ?? null,
      result.ok ? 'saved' : result.error.code,
    );
    return result;
  }

  private async save(
    context: CallContext,
    input: MyFileSaveIdentifierInput,
  ): Promise<Result<IdentifierSaved, MyFileSaveIdentifierFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, files, policy, identifierSchemes, identifierIndex, cipher, clock } =
      this.deps;

    const reserved = await reserveRateLimits(this.deps, context, SAVE_LIMITS, owner.accountId);
    if (!reserved.ok) return reserved;

    const scheme = identifierSchemes.schemeOf(market);
    const requirements = draftRequirementsOf(policy, market);
    if (scheme === null || requirements === null) return err({ code: 'sellers.unavailable' });

    const parsed = isBlank(input.identifier)
      ? null
      : parseBusinessIdentifier(input.identifier, scheme);
    if (parsed !== null && !parsed.ok) return err({ code: parsed.error });

    let plan: LookupPlan | null;
    try {
      plan = lookupPlanOf(this.deps, market);
    } catch (error) {
      this.#logger.error({
        msg: 'sellers.my-file-save-identifier.lookup-unavailable',
        error: error instanceof Error ? error.name : 'unknown',
        correlationId: context.correlationId,
      });
      return err({ code: 'sellers.unavailable' });
    }

    // The keyed index is pure, so it is known before the file is read; the read unit then loads
    // the file and the stored result of this value together (ADR-0025: a read-only unit, before
    // any key is used). A seller of another Market has no file: the same answer as an unknown id.
    const index =
      parsed === null ? null : identifierIndex.of(market, parsed.value.scheme, parsed.value.value);
    let loaded;
    try {
      loaded = await unitOfWork.run(
        market,
        async () => {
          const file = await files.findById(market, owner.sellerId);
          if (file === null) return ok(null);
          const existing =
            plan !== null && index !== null
              ? await this.deps.registerChecks.find(market, owner.sellerId, index)
              : null;
          return ok({ file, existing });
        },
        { readOnly: true },
      );
    } catch (error) {
      this.#logger.error({
        msg: 'sellers.my-file-save-identifier.read-failed',
        error: error instanceof Error ? error.name : 'unknown',
        correlationId: context.correlationId,
      });
      return err({ code: 'sellers.unavailable' });
    }
    if (!loaded.ok || loaded.value === null) return err({ code: 'file.not-found' });
    const { file: current, existing } = loaded.value;

    let identifier: DraftIdentifier | null = null;
    if (parsed !== null && index !== null) {
      const { value, scheme: code } = parsed.value;
      try {
        const sealed = await cipher.seal(market, owner.sellerId, 'identifier', value);
        if (!sealed.ok) return err({ code: 'sellers.unavailable' });
        identifier = { scheme: code, sealed: sealed.value, index };
      } catch (error) {
        // Name and correlation id only: never the message or the value (Hassan L2).
        this.#logger.error({
          msg: 'sellers.my-file-save-identifier.unavailable',
          error: error instanceof Error ? error.name : 'unknown',
          correlationId: context.correlationId,
        });
        return err({ code: 'sellers.unavailable' });
      }
    }

    // A dry run on the copy just read: a file the aggregate refuses (approved) spends no quota.
    const dryRun = current.saveIdentifier(identifier, clock.now(), requirements);
    if (!dryRun.ok) return dryRun;

    // Reserve before the work (design 7.7, ADR-0023 decision 1): a reached account limit refuses
    // the save of a new value and creates no result; a spent Market budget writes no result.
    const due: LookupPlan | null =
      plan !== null &&
      parsed !== null &&
      lookupDue(existing, clock.now(), plan.settings, current.state.lastChangedAt)
        ? plan
        : null;
    let verdict: QuotaVerdict = 'go';
    if (due !== null) {
      const quota = await reserveLookupQuota(
        this.deps,
        context,
        { accountId: owner.accountId, origin: input.origin ?? null },
        due.settings,
      );
      if (!quota.ok) return quota;
      verdict = quota.value;
    }

    // The file's last change as this save leaves it: a result is current only if made after it.
    let changedAt = current.state.lastChangedAt;
    // The file as this save leaves it, and when it was read: what the comparison is made against.
    let snapshot: SellerFile = current;
    let snapshotAt = clock.now();
    const saved = await unitOfWork.run<DraftSaved, MyFileSaveIdentifierFailure>(
      market,
      async () => {
        const file = await files.findById(market, owner.sellerId);
        if (file === null) return err({ code: 'file.not-found' });
        const applied = file.saveIdentifier(identifier, clock.now(), requirements);
        if (!applied.ok) return applied;
        changedAt = file.state.lastChangedAt;
        snapshot = file;
        snapshotAt = clock.now();
        if (Temporal.Instant.compare(snapshotAt, changedAt) < 0) snapshotAt = changedAt;
        if (file.state.version === file.persistedVersion) {
          return ok(draftSaved(file, requirements));
        }
        if (!(await files.saveDraft(market, file))) return err({ code: 'conflict.stale' });
        return ok(draftSaved(file, requirements));
      },
    );
    if (!saved.ok) return saved;

    if (plan === null || parsed === null || index === null) {
      return ok({ ...saved.value, registerResult: null });
    }
    let check: RegisterCheck | null = existing;
    if (due !== null) {
      const by = { kind: 'seller', accountId: owner.accountId } as const;
      check =
        verdict === 'go'
          ? await runLookup(this.deps, context, due, {
              sellerId: owner.sellerId,
              scheme: parsed.value.scheme,
              identifier: parsed.value.value,
              index,
              file: snapshot,
              snapshotAt,
              by,
            })
          : // A spent Market budget writes no result row: the state stays as it was and the
            // next save tries again (counted and logged by the quota reservation).
            existing;
      // A result that could not be stored is not claimed: the file stays "not performed" and a
      // reviewer checks the number (AC 32); the seller is told it could not be checked.
      if (check === null) return ok({ ...saved.value, registerResult: 'could-not-be-checked' });
    }
    return ok({
      ...saved.value,
      registerResult: sellerResultOf(check, clock.now(), plan.settings, changedAt),
    });
  }
}
