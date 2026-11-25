import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_APPROVE } from '../../contracts/permissions';
import { OFFER_CHANGE_REASONS, type OfferChangeReason } from '../../domain/events';
import type { OfferRepository } from '../ports/offer.repository';
import { parseDecision, type ReviewValidationFailure } from '../offer-review-input';
import type { SellerReviewProbation } from '../seller-review-probation';

export interface OfferRequestChangesInput {
  readonly offerId: string;
  /** The Offer version the reviewer saw. */
  readonly version: number;
  /** One of {@link OFFER_CHANGE_REASONS}. */
  readonly reasonCode: string;
}

export type OfferRequestChangesFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'offer.not-found' }
  | { readonly code: 'offer.not-pending-review' }
  | { readonly code: 'conflict.stale' }
  | ReviewValidationFailure;

export interface OfferRequestChangesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  /** The seller's probation counter (slice 4), moved in the request's unit. */
  readonly probation: SellerReviewProbation;
}

/**
 * `offer.request-changes` (catalog design 4.4, 8.2): a reviewer sends an Offer that waits for its
 * first publication back to the seller with a reason code. Rule: the key `catalog.product.approve`
 * and the admin population. The request names the Offer, the version the reviewer saw and one
 * reason of a closed list; free text is never accepted. The Offer becomes `changes-needed` and
 * `catalog.offer-changes-requested.v1` (the code, ids only) goes to the outbox for the seller's
 * mail; the seller's edit returns it to `draft`.
 *
 * Probation (risk-based Offer approval slice 4): in probation, the second Changes needed in a row
 * (seller-wide) restarts the seller's count. N and the Trusted-from-start switch are read before
 * the unit; in the unit the standing is locked after the Offer row.
 */
export class OfferRequestChanges extends UseCase<
  OfferRequestChangesInput,
  Record<string, never>,
  OfferRequestChangesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.offer-request-changes',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_APPROVE.key] },
  };

  readonly #logger = new Logger('OfferRequestChanges');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OfferRequestChangesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OfferRequestChangesInput,
  ): Promise<Result<Record<string, never>, OfferRequestChangesFailure>> {
    const result = await this.#request(context, input);
    this.#logger.log({
      msg: 'catalog.offer-request-changes',
      code: result.ok ? 'changes-requested' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #request(
    context: CallContext,
    input: OfferRequestChangesInput,
  ): Promise<Result<Record<string, never>, OfferRequestChangesFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const parsed = parseDecision(input, ['reasonCode']);
    if (!parsed.ok) return parsed;
    const { offerId, version, raw } = parsed.value;
    const reason = raw['reasonCode'];
    if (
      typeof reason !== 'string' ||
      !(OFFER_CHANGE_REASONS as readonly string[]).includes(reason)
    ) {
      return err({ code: 'validation.failed', fields: [{ path: 'reasonCode', code: 'unknown' }] });
    }
    const { deps } = this;
    // The seller of the Offer, then N and its Trusted-from-start switch, outside any unit.
    const seen = await deps.unitOfWork.run(
      market,
      async () => ok((await deps.offers.findById(market, offerId))?.state.sellerId ?? null),
      { readOnly: true },
    );
    if (!seen.ok) return err({ code: 'access.unavailable' });
    if (seen.value === null) return err({ code: 'offer.not-found' });
    const probation = await deps.probation.prepare(context, seen.value);
    try {
      return await deps.unitOfWork.run<Record<string, never>, OfferRequestChangesFailure>(
        market,
        async () => {
          const offer = await deps.offers.findById(market, offerId);
          if (offer === null) return err({ code: 'offer.not-found' } as const);
          if (offer.state.status !== 'pending-first-publish') {
            return err({ code: 'offer.not-pending-review' } as const);
          }
          if (offer.state.version !== version) return err({ code: 'conflict.stale' } as const);
          if (offer.state.sellerId !== probation.sellerId) {
            return err({ code: 'conflict.stale' } as const);
          }
          const now = deps.clock.now();
          const asked = offer.requestChanges({ reasonCode: reason as OfferChangeReason, now });
          if (!asked.ok) return err({ code: 'offer.not-pending-review' } as const);
          await deps.offers.save(market, offer, { kind: 'admin', accountId: actor.accountId });
          // Lock order: the Offer row (saved above), then the seller's standing.
          await deps.probation.recordChangesNeeded(context, probation, now);
          await deps.outbox.append(context, offer.pendingEvents);
          return ok({});
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
  }
}
