import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { isActingAsSession } from '../acting-as';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import {
  OFFER_HANDLINGS,
  offerStateWithHandling,
  type Offer,
  type OfferHandling,
} from '../../domain/offer';
import {
  sellerReviewReasonsOf,
  type OfferReviewReason,
  type SellerReviewReason,
} from '../../domain/offer-review-policy';
import { isWatched, type OfferEditReview, type WatchedChange } from '../offer-edit-review';
import { clearanceFromPolicy } from '../offer-review-clearance';
import type { ClaimEvaluator } from '../ports/claim-evaluator';
import type { ClaimQueryBuilder } from '../tags/claim-query-builder';
import {
  askPrepared,
  claimsFailClosed,
  factsInUnit,
  hashesOf,
  keptTagTypes,
  MAX_CLAIM_ATTEMPTS,
  NOTHING_ASKED,
  preparePublishedAsk,
  RETRY,
  sellerTagActor,
} from '../tags/offer-claims';
import type { OfferRepository } from '../ports/offer.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type { SaveWorkingCopy } from '../working-copy/save-working-copy.service';

/** The request as the route passes it: the Offer and the handling, a closed shape (B1, L8). */
export interface OwnOfferSetHandlingInput {
  readonly offerId: string;
  readonly handling: unknown;
  /** A held change of a live Offer is set aside and this change is judged alone (slice 2c). */
  readonly replacePending?: unknown;
}

export interface OwnOfferSetHandlingOutput {
  /** `['handling']` when the value changed; empty when the Offer already held it or it is held. */
  readonly changedFields: readonly string[];
  /** False when the review policy held the change of a live Offer (slice 2c). */
  readonly applied: boolean;
  /** The held change, when `applied` is false. */
  readonly pendingChangeId?: string;
  /** Why it is held, as a seller is told (`sellerReviewReasonsOf`), when `applied` is false. */
  readonly reasons?: readonly SellerReviewReason[];
}

export type OwnOfferSetHandlingFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'offer.not-found' }
  | { readonly code: 'offer.not-editable' }
  /** A handling change of a live Offer with a held change open, without `replacePending`. */
  | { readonly code: 'offer.change-pending' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'claim.check-unavailable' }
  | { readonly code: 'conflict.retry' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnOfferSetHandlingDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly eligibility: SellerEligibilityReader;
  /** Spends the account's save budget (design 8.4: shared with draft saves and Offer edits). */
  readonly save: Pick<SaveWorkingCopy, 'reserveSaves'>;
  /** The claim facts and queries of the kept tags (design 5.1). */
  readonly claims: ClaimQueryBuilder;
  readonly evaluator: ClaimEvaluator;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  /** The edit rules of a live Offer (slice 2c). */
  readonly editReview: OfferEditReview;
}

const INPUT_KEYS = ['offerId', 'handling', 'replacePending'] as const;

/**
 * `own-offer.set-handling` (catalog design 4.4, 8.2; Ali B1): a seller records how the goods of
 * their own Offer are handled. A command of its own, not part of `own-offer.edit`. Rule: the key
 * `catalog.own-product.edit` and the seller population; the gate refuses a seller who is not
 * approved. The seller comes from the actor. Guards, in order: seller actor, may-sell, closed
 * and well-formed input (handling is one of the four codes), the account's save budget, then one
 * unit that reads the Offer (another seller's, deleted and unknown Offers are one byte-identical
 * `offer.not-found`), sets the handling and stores it with an `edited` history row holding the
 * field id only. Handling is a claim input (design 5.1), so every kept tag is asked again against
 * the new handling, outside any unit, and settled in the unit that stores it (AC 11): a tag no
 * longer allowed is `suspended` and the Offer goes off sale; one `unavailable` answer refuses the
 * change (`claim.check-unavailable`). The unit reads the Offer again under the version that was
 * asked; a lost race asks again, at most {@link MAX_CLAIM_ATTEMPTS} times, then `conflict.retry`.
 * A waiting Offer returns to `draft`; a published Offer stays published. Acting-as (Login as
 * Seller) must refuse this command; the actor has no acting-as field until SEL-08, so it is added
 * there (open carry).
 *
 * Edit rules of a live Offer (slice 2c; ADR-0051): on a `published` Offer a handling change is a
 * watched change. With a held change open it is refused (`offer.change-pending`) unless
 * `replacePending: true`. The Market's review settings are read outside any unit (fail closed).
 * No reason (R3 holds anything but `SEALED_ORIGINAL`; mode `all` holds every change): the handling
 * applies as above with an `edit` referral. A reason: nothing of the Offer changes but its version;
 * the handling is held as a pending change with its referral and audit rows, and the answer is
 * `applied: false` with the change id and reasons. A held change asks no claim.
 */
export class OwnOfferSetHandling extends UseCase<
  OwnOfferSetHandlingInput,
  OwnOfferSetHandlingOutput,
  OwnOfferSetHandlingFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-offer-set-handling',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnOfferSetHandling');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnOfferSetHandlingDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOfferSetHandlingInput,
  ): Promise<Result<OwnOfferSetHandlingOutput, OwnOfferSetHandlingFailure>> {
    const result = await this.#set(context, input);
    this.#logger.log({
      msg: 'catalog.own-offer-set-handling',
      code: result.ok ? (result.value.applied ? 'set' : 'held') : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #set(
    context: CallContext,
    input: OwnOfferSetHandlingInput,
  ): Promise<Result<OwnOfferSetHandlingOutput, OwnOfferSetHandlingFailure>> {
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
    if (
      typeof input.handling !== 'string' ||
      !(OFFER_HANDLINGS as readonly string[]).includes(input.handling)
    ) {
      return fail('handling', 'invalid');
    }
    const handling = input.handling as OfferHandling;
    if (input.replacePending !== undefined && typeof input.replacePending !== 'boolean') {
      return fail('replacePending', 'type');
    }
    const replacePending = input.replacePending === true;

    const throttled = await deps.save.reserveSaves(context);
    if (throttled !== null) return err(throttled);

    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      const outcome = await claimsFailClosed(() =>
        this.#attempt(context, offerId.value, sellerId, handling, replacePending),
      );
      if (outcome !== RETRY) return outcome;
    }
    return err({ code: 'conflict.retry' });
  }

  async #attempt(
    context: CallContext,
    offerId: Id<'Offer'>,
    sellerId: Id<'Seller'>,
    handling: OfferHandling,
    replacePending: boolean,
  ): Promise<Result<OwnOfferSetHandlingOutput, OwnOfferSetHandlingFailure> | typeof RETRY> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    const { deps } = this;
    const ownOffer = async (): Promise<Offer | null> => {
      const offer = await deps.offers.findById(market, offerId);
      if (offer === null) return null;
      return offer.state.sellerId === sellerId && offer.state.status !== 'deleted' ? offer : null;
    };

    // Read-only first: the Offer and the queries of its kept tags against the new handling.
    const guard = await deps.unitOfWork.run(
      market,
      async () => {
        const offer = await ownOffer();
        if (offer === null) return ok(null);
        const types = keptTagTypes(offer);
        // The state after the change (never stored): the claim queries of the kept tags.
        const after = offerStateWithHandling(offer.state, handling);
        const prepared = await preparePublishedAsk(deps.claims, market, after, types);
        const live = offer.state.status === 'published';
        const open = live ? await deps.editReview.openChange(market, offer.state.id) : null;
        // The watched part (slice 2c): a changed handling of a live Offer.
        const watched: WatchedChange =
          live && handling !== offer.state.handling
            ? { addedBadgeTypes: [], newHandling: handling }
            : { addedBadgeTypes: [] };
        return ok({
          version: offer.state.version,
          sellerId: offer.state.sellerId,
          productId: offer.state.productId,
          prepared,
          watched,
          live,
          hasOpenChange: open !== null,
        });
      },
      { readOnly: true },
    );
    if (!guard.ok) return err({ code: 'access.unavailable' });
    if (guard.value === null) return err({ code: 'offer.not-found' });
    const { version, watched } = guard.value;
    const watchedEdit = guard.value.live && isWatched(watched);
    if (watchedEdit && guard.value.hasOpenChange && !replacePending) {
      return err({ code: 'offer.change-pending' });
    }
    // The review policy, outside any unit; any failure holds the change (fail closed).
    const subject = { offerId, sellerId: guard.value.sellerId, productId: guard.value.productId };
    const verdict = watchedEdit ? await deps.editReview.verdict(context, subject, watched) : null;
    const reasons = verdict?.reasons ?? [];
    const held = reasons.length > 0;
    // A held change asks nothing: the Offer keeps its handling and its tags as they are.
    const prepared = held ? NOTHING_ASKED : guard.value.prepared;
    if (prepared === 'unavailable') return err({ code: 'claim.check-unavailable' });

    const asked = await askPrepared(deps.evaluator, context, prepared);
    if (!asked.ok) return err(asked.error);
    const hash = hashesOf(prepared);

    try {
      const written = await deps.unitOfWork.run<
        OwnOfferSetHandlingOutput | typeof RETRY,
        OwnOfferSetHandlingFailure
      >(market, async () => {
        const offer = await ownOffer();
        if (offer === null) return err({ code: 'offer.not-found' } as const);
        if (offer.state.version !== version) return ok(RETRY);
        const replaced = watchedEdit ? await deps.editReview.openChange(market, offerId) : null;
        if (replaced !== null && !replacePending) {
          return err({ code: 'offer.change-pending' } as const);
        }
        const now = deps.clock.now();
        if (held) return this.#hold(context, offer, { version, reasons, watched, replaced, now });
        const set = offer.setHandling({
          handling,
          now,
          review: clearanceFromPolicy(verdict),
        });
        if (!set.ok) {
          return err(
            set.error.code === 'offer.not-editable'
              ? ({ code: 'offer.not-editable' } as const)
              : ({
                  code: 'validation.failed',
                  fields: [{ path: 'handling', code: 'invalid' }],
                } as const),
          );
        }
        // The facts again, in this unit: a revision published since the ask means asking again.
        const facts = await factsInUnit(deps.claims, market, offer.state.productId, prepared);
        if (facts === RETRY) return ok(RETRY);
        const settled = offer.settleTags({
          facts,
          decisions: asked.value,
          entryPath: 'handling-change',
          actor: sellerTagActor(actor),
          hash,
          now,
        });
        if (!settled.ok) {
          return settled.error.code === 'claim.inputs-changed'
            ? ok(RETRY)
            : err({ code: 'claim.check-unavailable' } as const);
        }
        if (replaced !== null) offer.markReviewChange();
        // A save with no pending change stores nothing.
        const refusal = await deps.offers.save(market, offer, {
          kind: 'seller',
          accountId: actor.accountId,
        });
        if (refusal !== null) return err({ code: 'conflict.stale' } as const);
        if (watchedEdit) {
          await deps.editReview.settle(context, {
            offer,
            baseVersion: version,
            reasons,
            change: watched,
            replaced,
            now,
          });
        }
        await deps.outbox.append(context, offer.pendingEvents);
        return ok({ changedFields: set.value, applied: true });
      });
      if (written.ok && written.value === RETRY) return RETRY;
      return written as Result<OwnOfferSetHandlingOutput, OwnOfferSetHandlingFailure>;
    } catch (error) {
      if (error instanceof StaleAggregateError) return RETRY;
      throw error;
    }
  }
  /**
   * In the unit: the handling of a live Offer held for review. The Offer changes only its version
   * (saved first: lock order), then the pending change, its referral and audit rows are written.
   */
  async #hold(
    context: CallContext,
    offer: Offer,
    held: {
      readonly version: number;
      readonly reasons: readonly OfferReviewReason[];
      readonly watched: WatchedChange;
      readonly replaced: Awaited<ReturnType<OfferEditReview['openChange']>>;
      readonly now: Temporal.Instant;
    },
  ): Promise<Result<OwnOfferSetHandlingOutput, OwnOfferSetHandlingFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    offer.markReviewChange();
    const refusal = await this.deps.offers.save(market, offer, {
      kind: 'seller',
      accountId: actor.accountId,
    });
    if (refusal !== null) return err({ code: 'conflict.stale' });
    const pendingChangeId = await this.deps.editReview.settle(context, {
      offer,
      baseVersion: held.version,
      reasons: held.reasons,
      change: held.watched,
      replaced: held.replaced,
      now: held.now,
    });
    if (pendingChangeId === null) throw new Error('set-handling: a held change has no id');
    return ok({
      changedFields: [],
      applied: false,
      pendingChangeId,
      reasons: sellerReviewReasonsOf(held.reasons),
    });
  }
}
