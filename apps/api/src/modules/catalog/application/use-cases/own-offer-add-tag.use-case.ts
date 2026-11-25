import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import { isActingAsSession } from '../acting-as';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import type { Offer } from '../../domain/offer';
import { claimQueriesFor, isTagTypeCode, judgeTag, type TagBasis } from '../../domain/offer-tag';
import type { OfferReviewReason } from '../../domain/offer-review-policy';
import { isWatched, type OfferEditReview, type WatchedChange } from '../offer-edit-review';
import { clearanceFromPolicy } from '../offer-review-clearance';
import type { ClaimEvaluator } from '../ports/claim-evaluator';
import type { OfferRepository } from '../ports/offer.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type { ClaimQueryBuilder } from '../tags/claim-query-builder';
import {
  askPrepared,
  claimsFailClosed,
  factsInUnit,
  hashesOf,
  MAX_CLAIM_ATTEMPTS,
  RETRY,
  sellerTagActor,
  tagFailureOf,
  type PreparedAsk,
  type TagCommandFailure,
} from '../tags/offer-claims';
import type { SaveWorkingCopy } from '../working-copy/save-working-copy.service';

export interface OwnOfferAddTagInput {
  readonly offerId: string;
  readonly typeCode: unknown;
  /** A held change of a live Offer is set aside and this request is judged alone (slice 2c). */
  readonly replacePending?: unknown;
}

export interface OwnOfferAddTagOutput {
  readonly typeCode: string;
  /** `held` when the review policy held the new badge of a live Offer (slice 2c). */
  readonly status: 'active' | 'held';
  /**
   * Every answer that shows a tag shows its basis (CERT-24, CERT-44; AC 14); null for a held
   * request, which writes no tag (the approval asks again).
   */
  readonly basis: TagBasis | null;
  /** False when the request is held. */
  readonly applied: boolean;
  /** The held change, when `applied` is false. */
  readonly pendingChangeId?: string;
  /** The policy's reasons, when `applied` is false. */
  readonly reasons?: readonly OfferReviewReason[];
}

export type OwnOfferAddTagFailure =
  | TagCommandFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'seller.not-eligible' }
  /** A new badge on a live Offer with a held change open, without `replacePending`. */
  | { readonly code: 'offer.change-pending' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnOfferAddTagDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly eligibility: SellerEligibilityReader;
  readonly save: Pick<SaveWorkingCopy, 'reserveSaves'>;
  readonly claims: ClaimQueryBuilder;
  readonly evaluator: ClaimEvaluator;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** The edit rules of a live Offer (slice 2c). */
  readonly editReview: OfferEditReview;
}

const INPUT_KEYS = ['offerId', 'typeCode', 'replacePending'] as const;

/**
 * `own-offer.add-tag` (catalog design 5.2, 5.3, 8.2; CERT-21; AC 7 to 9, 15): a seller adds a
 * certification type to their own Offer. Rule: the key `catalog.own-product.edit`, the seller
 * population, a seller who may sell. The input is the Offer id and a type code only: no decision,
 * basis, certificate, issuer, status or badge (5.2 point 6). Refused in an acting-as session (8.2
 * "AA"); the actor carries no acting-as field until SEL-08, so the refusal arrives there.
 *
 * Order: seller actor; may-sell; closed input; the save budget; the type is an active type of the
 * Market (`tag.type-unknown`). Then, up to {@link MAX_CLAIM_ATTEMPTS} times: a read-only unit reads
 * the Offer (another seller's, deleted or unknown: one `offer.not-found`) and the claim facts of
 * the product's published revision (never published: `tag.product-not-published`, where the first
 * submit's `requestedTags` is the path, 5.1a point 6), and `ClaimQueryBuilder` builds one query per
 * variant; `evaluateClaims` is asked outside any unit; one unit reads the Offer again under its
 * version and the facts again, and the domain writes the tag `active` only when every variant is
 * allowed and every returned input equals the state being saved. A lost race asks again; after
 * the last attempt `conflict.retry`. A refusal names the type and the reason code;
 * `unavailable` refuses with `claim.check-unavailable` (fail closed).
 *
 * Edit rules of a live Offer (slice 2c; ADR-0051): on a `published` Offer a new badge type is a
 * watched change. With a held change open it is refused (`offer.change-pending`) unless
 * `replacePending: true`. The claim is asked first (a type not allowed is refused at once, never
 * queued); then the Market's review settings, read outside any unit (fail closed). No reason
 * (R2 with `certificateBadges: review`, or mode `all`): the tag is written as above with an `edit`
 * referral. A reason: no tag row is written; the type code is held as a pending change with its
 * referral and audit rows, the Offer's version rises once, and the answer is `status: held`,
 * `applied: false`. The approval asks certification again.
 */
export class OwnOfferAddTag extends UseCase<
  OwnOfferAddTagInput,
  OwnOfferAddTagOutput,
  OwnOfferAddTagFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-offer-add-tag',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnOfferAddTag');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnOfferAddTagDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOfferAddTagInput,
  ): Promise<Result<OwnOfferAddTagOutput, OwnOfferAddTagFailure>> {
    const result = await this.#add(context, input);
    this.#logger.log({
      msg: 'catalog.own-offer-add-tag',
      code: result.ok ? (result.value.applied ? 'added' : 'held') : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #add(
    context: CallContext,
    input: OwnOfferAddTagInput,
  ): Promise<Result<OwnOfferAddTagOutput, OwnOfferAddTagFailure>> {
    const { actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null ||
      // Not offered in an acting-as session (design 8.2 "AA"; Hassan L1).
      isActingAsSession(actor)
    ) {
      return err({ code: 'access.denied' });
    }
    const sellerId = actor.sellerId;
    const { deps } = this;
    if (!(await deps.eligibility.isEligible(context, sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }
    const fail = (path: string, code: string) =>
      err({ code: 'validation.failed', fields: [{ path, code }] } as const);
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return fail('body', 'type');
    }
    for (const key of Object.keys(input)) {
      if (!(INPUT_KEYS as readonly string[]).includes(key)) return fail(key, 'unknown');
    }
    const offerId = typeof input.offerId === 'string' ? parseId<'Offer'>(input.offerId) : null;
    if (offerId === null || !offerId.ok) return fail('offerId', 'format');
    if (!isTagTypeCode(input.typeCode)) return fail('typeCode', 'format');
    const typeCode = input.typeCode;
    if (input.replacePending !== undefined && typeof input.replacePending !== 'boolean') {
      return fail('replacePending', 'type');
    }
    const replacePending = input.replacePending === true;

    const throttled = await deps.save.reserveSaves(context);
    if (throttled !== null) return err(throttled);

    const active = await deps.evaluator.activeTypeCodes(context);
    if (!active.ok) return err(active.error);
    if (!active.value.has(typeCode)) return err({ code: 'tag.type-unknown' });

    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      const outcome = await claimsFailClosed(() =>
        this.#attempt(context, offerId.value, sellerId, typeCode, replacePending),
      );
      if (outcome !== RETRY) return outcome;
    }
    return err({ code: 'conflict.retry' });
  }

  async #attempt(
    context: CallContext,
    offerId: Id<'Offer'>,
    sellerId: Id<'Seller'>,
    typeCode: string,
    replacePending: boolean,
  ): Promise<Result<OwnOfferAddTagOutput, OwnOfferAddTagFailure> | typeof RETRY> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    const { deps } = this;
    const ownOffer = async (): Promise<Offer | null> => {
      const offer = await deps.offers.findById(market, offerId);
      if (offer === null) return null;
      return offer.state.sellerId === sellerId && offer.state.status !== 'deleted' ? offer : null;
    };

    const guard = await deps.unitOfWork.run<
      {
        readonly version: number;
        readonly prepared: PreparedAsk | 'unavailable';
        readonly live: boolean;
        readonly hasOpenChange: boolean;
      },
      OwnOfferAddTagFailure
    >(
      market,
      async () => {
        const offer = await ownOffer();
        if (offer === null) return err({ code: 'offer.not-found' });
        if (offer.tags.some((tag) => tag.typeCode === typeCode)) return err({ code: 'tag.exists' });
        if (offer.state.handling === null) return err({ code: 'offer.handling-missing' });
        const { facts, productVersion } = await deps.claims.publishedSnapshot(
          market,
          offer.state.productId,
        );
        if (facts === null) return err({ code: 'tag.product-not-published' });
        const queries = deps.claims.queries(offer.state, facts, [typeCode]);
        if (queries === null) return err({ code: 'offer.handling-missing' });
        const live = offer.state.status === 'published';
        const open = live ? await deps.editReview.openChange(market, offer.state.id) : null;
        return ok({
          version: offer.state.version,
          prepared: { facts, queries, productVersion },
          live,
          hasOpenChange: open !== null,
        });
      },
      { readOnly: true },
    );
    if (!guard.ok) return guard;
    // The watched part (slice 2c): a new badge type on a live Offer.
    const watched: WatchedChange = { addedBadgeTypes: guard.value.live ? [typeCode] : [] };
    const watchedEdit = isWatched(watched);
    if (watchedEdit && guard.value.hasOpenChange && !replacePending) {
      return err({ code: 'offer.change-pending' });
    }
    const prepared = guard.value.prepared;
    if (prepared === 'unavailable') return err({ code: 'claim.check-unavailable' });
    const hash = hashesOf(prepared);

    // Outside any unit (the facade opens its own); nothing of the answer is kept past this request.
    const asked = await askPrepared(deps.evaluator, context, prepared);
    if (!asked.ok) return err(asked.error);

    // The review policy, outside any unit; any failure holds the change (fail closed).
    const reasons: readonly OfferReviewReason[] = watchedEdit
      ? await deps.editReview.reasons(context, watched)
      : [];

    try {
      const written = await deps.unitOfWork.run<
        OwnOfferAddTagOutput | typeof RETRY,
        OwnOfferAddTagFailure
      >(market, async () => {
        const offer = await ownOffer();
        if (offer === null) return err({ code: 'offer.not-found' });
        if (offer.state.version !== guard.value.version) return ok(RETRY);
        // The facts again, in this unit: a revision published since the ask means asking again.
        const facts = await factsInUnit(deps.claims, market, offer.state.productId, prepared);
        if (facts === RETRY) return ok(RETRY);
        if (facts === null) return err({ code: 'tag.product-not-published' });
        const replaced = watchedEdit ? await deps.editReview.openChange(market, offerId) : null;
        if (replaced !== null && !replacePending) return err({ code: 'offer.change-pending' });
        const now = deps.clock.now();
        if (reasons.length > 0) {
          // Held: the type must be allowed now (a refusal is never queued), judged by the
          // domain's own rule against this state; no tag row is written.
          const expected = claimQueriesFor(offer.state, facts, typeCode);
          if (expected === null) return err({ code: 'offer.handling-missing' });
          const judgement = judgeTag(expected, asked.value.get(typeCode));
          if (judgement.kind === 'stale') return ok(RETRY);
          if (judgement.kind === 'unavailable') return err({ code: 'claim.check-unavailable' });
          if (judgement.kind === 'not-allowed') {
            return err({
              code: 'claim.tag-not-allowed',
              tags: [{ typeCode, reason: judgement.reason }],
            });
          }
          offer.markReviewChange();
          await deps.offers.save(market, offer, { kind: 'seller', accountId: actor.accountId });
          const pendingChangeId = await deps.editReview.settle(context, {
            offer,
            baseVersion: guard.value.version,
            reasons,
            change: watched,
            replaced,
            now,
          });
          if (pendingChangeId === null) throw new Error('add-tag: a held change has no id');
          return ok({
            typeCode,
            status: 'held',
            basis: null,
            applied: false,
            pendingChangeId,
            reasons,
          });
        }
        const added = offer.addTags({
          tags: [{ tagId: deps.ids.next<'OfferTag'>(), typeCode }],
          facts,
          decisions: asked.value,
          entryPath: 'tag-add',
          actor: sellerTagActor(actor),
          hash,
          now,
          review: clearanceFromPolicy(reasons) ?? undefined,
        });
        if (!added.ok) {
          return added.error.code === 'claim.inputs-changed'
            ? ok(RETRY)
            : err(tagFailureOf(added.error));
        }
        if (replaced !== null) offer.markReviewChange();
        await deps.offers.save(market, offer, { kind: 'seller', accountId: actor.accountId });
        if (watchedEdit) {
          await deps.editReview.settle(context, {
            offer,
            baseVersion: guard.value.version,
            reasons,
            change: watched,
            replaced,
            now,
          });
        }
        await deps.outbox.append(context, offer.pendingEvents);
        const tag = offer.tags.find((t) => t.typeCode === typeCode && t.status === 'active');
        if (tag?.copy == null) throw new Error('add-tag: the added tag has no copy');
        return ok({ typeCode, status: 'active', basis: tag.copy.basis, applied: true });
      });
      if (written.ok && written.value === RETRY) return RETRY;
      return written as Result<OwnOfferAddTagOutput, OwnOfferAddTagFailure>;
    } catch (error) {
      if (error instanceof StaleAggregateError) return RETRY;
      throw error;
    }
  }
}
