import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { CatalogFacade, OfferPostReviewReferralReason } from '../../../catalog';
import type { PostReviewFlagReason } from '../../domain/events';

/** One delivery of `pricing.offer-post-review-flagged.v1`. */
export interface ReferOfferForPostReviewInput {
  readonly delivery: EventDelivery;
  readonly offerId: Id<'Offer'>;
  readonly sellerId: Id<'Seller'>;
  readonly recordId: string;
  readonly reason: PostReviewFlagReason;
}

export interface ReferOfferForPostReviewOutput {
  /** Catalog's answer: `post-review.opened`, `.extended`, `.unchanged`, `.duplicate` or `.offer-gone`. */
  readonly code: string;
}

export type ReferOfferForPostReviewFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'pricing.post-review.refused'; readonly catalogCode: string };

export interface ReferOfferForPostReviewDependencies {
  readonly catalog: Pick<CatalogFacade, 'referOfferForPostReview'>;
}

/** Pricing's flag reasons, as catalog's post-publication review reasons. */
const CATALOG_REASON: Readonly<Record<PostReviewFlagReason, OfferPostReviewReferralReason>> = {
  'no-reference': 'price-no-reference',
  'reference-unavailable': 'price-reference-unavailable',
  'recheck-outside': 'price-recheck-outside',
};

/**
 * The handler `pricing.refer-offer-for-post-review` (risk-based Offer approval slice 6). Rule
 * `system`, from pricing's own subscription on `pricing.offer-post-review-flagged.v1`; the Market
 * comes from the envelope. It hands the flag to catalog's post-publication review list through
 * `CatalogFacade.referOfferForPostReview`, keyed on the first-price record: catalog stores each
 * (Offer, reason, record) once, so a redelivery answers `duplicate` and changes nothing (no inbox
 * row needed). A refusal is returned, and the subscriber throws so the delivery is retried. Logs
 * hold ids and codes only.
 */
export class ReferOfferForPostReview extends UseCase<
  ReferOfferForPostReviewInput,
  ReferOfferForPostReviewOutput,
  ReferOfferForPostReviewFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.refer-offer-for-post-review',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('ReferOfferForPostReview');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReferOfferForPostReviewDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ReferOfferForPostReviewInput,
  ): Promise<Result<ReferOfferForPostReviewOutput, ReferOfferForPostReviewFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const referred = await this.deps.catalog.referOfferForPostReview(context, {
      offerId: input.offerId,
      sellerId: input.sellerId,
      reason: CATALOG_REASON[input.reason],
      sourceRef: input.recordId,
    });
    this.#logger.log({
      msg: 'pricing.refer-offer-for-post-review',
      code: referred.ok ? referred.value.code : referred.error.code,
      offerId: input.offerId,
      reason: input.reason,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!referred.ok) {
      return err({ code: 'pricing.post-review.refused', catalogCode: referred.error.code });
    }
    return ok({ code: referred.value.code });
  }
}
