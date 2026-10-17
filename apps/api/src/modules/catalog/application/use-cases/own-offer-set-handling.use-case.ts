import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { isActingAsSession } from '../acting-as';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { Offer, OFFER_HANDLINGS, type OfferHandling } from '../../domain/offer';
import type { ClaimEvaluator } from '../ports/claim-evaluator';
import type { ClaimQueryBuilder } from '../tags/claim-query-builder';
import {
  askPrepared,
  claimsFailClosed,
  factsInUnit,
  hashesOf,
  keptTagTypes,
  MAX_CLAIM_ATTEMPTS,
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
}

export interface OwnOfferSetHandlingOutput {
  /** `['handling']` when the value changed; empty when the Offer already held it. */
  readonly changedFields: readonly string[];
}

export type OwnOfferSetHandlingFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'offer.not-found' }
  | { readonly code: 'offer.not-editable' }
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
}

const INPUT_KEYS = ['offerId', 'handling'] as const;

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
      code: result.ok ? 'set' : result.error.code,
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

    const throttled = await deps.save.reserveSaves(context);
    if (throttled !== null) return err(throttled);

    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      const outcome = await claimsFailClosed(() =>
        this.#attempt(context, offerId.value, sellerId, handling),
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
        // The state after the change, built on a copy that is never stored.
        const after = Offer.restore(offer.state, offer.tags);
        after.setHandling({ handling, now: deps.clock.now() });
        const prepared = await preparePublishedAsk(deps.claims, market, after.state, types);
        return ok({ version: offer.state.version, prepared });
      },
      { readOnly: true },
    );
    if (!guard.ok) return err({ code: 'access.unavailable' });
    if (guard.value === null) return err({ code: 'offer.not-found' });
    const { version, prepared } = guard.value;
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
        const now = deps.clock.now();
        const set = offer.setHandling({ handling, now });
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
        // A save with no pending change stores nothing.
        const refusal = await deps.offers.save(market, offer, {
          kind: 'seller',
          accountId: actor.accountId,
        });
        if (refusal !== null) return err({ code: 'conflict.stale' } as const);
        await deps.outbox.append(context, offer.pendingEvents);
        return ok({ changedFields: set.value });
      });
      if (written.ok && written.value === RETRY) return RETRY;
      return written as Result<OwnOfferSetHandlingOutput, OwnOfferSetHandlingFailure>;
    } catch (error) {
      if (error instanceof StaleAggregateError) return RETRY;
      throw error;
    }
  }
}
