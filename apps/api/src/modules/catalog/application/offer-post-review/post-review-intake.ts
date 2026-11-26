import type { Id, IdGenerator, MarketContext, Temporal } from '@mondapac/shared-kernel';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import {
  OfferPostReview,
  type OfferPostReviewReason,
  type SampleFigures,
} from '../../domain/offer-post-review';
import type { OfferPostReviewRepository } from '../ports/offer-post-review';

export interface PostReviewIntakeDependencies {
  readonly postReviews: OfferPostReviewRepository;
  readonly ids: IdGenerator;
}

/** What one reason did: a new open row, a reason added to the open row, nothing new, a redelivery. */
export type PostReviewIntakeOutcome = 'opened' | 'extended' | 'unchanged' | 'duplicate';

/** The source of a sample reason: the Offer version that was drawn. */
export const sampleSourceRef = (offerVersion: number): string => `offer-version:${offerVersion}`;

/**
 * In the caller's unit (after the Offer row, when the caller writes it): one reason for an
 * Offer's post-publication review (slice 6). A source already received is a redelivery and
 * changes nothing (idempotent on market, Offer, reason and source). Otherwise the reason goes on
 * the Offer's open row (once; a reason already there changes nothing), or opens a new row when
 * the Offer has none open; then the source is recorded. A row another unit changed or opened
 * first throws `StaleAggregateError`, so the whole unit rolls back and the caller asks again.
 */
export async function receivePostReviewReason(
  deps: PostReviewIntakeDependencies,
  market: MarketContext,
  input: {
    readonly offerId: Id<'Offer'>;
    readonly sellerId: Id<'Seller'>;
    readonly productId: Id<'Product'>;
    readonly reason: OfferPostReviewReason;
    readonly sourceRef: string;
    readonly sample?: SampleFigures | null;
    readonly now: Temporal.Instant;
  },
): Promise<PostReviewIntakeOutcome> {
  const { postReviews } = deps;
  const key = { offerId: input.offerId, reason: input.reason, sourceRef: input.sourceRef };
  if (await postReviews.received(market, key)) return 'duplicate';
  let outcome: PostReviewIntakeOutcome;
  let review = await postReviews.findOpenByOffer(market, input.offerId);
  if (review === null) {
    const opened = OfferPostReview.open({
      id: deps.ids.next<'OfferPostReview'>(),
      marketId: market.marketId,
      offerId: input.offerId,
      sellerId: input.sellerId,
      productId: input.productId,
      reason: input.reason,
      sample: input.sample ?? null,
      now: input.now,
    });
    if (!opened.ok) throw new Error(`post-review intake: ${opened.error.code}`);
    review = opened.value;
    await postReviews.insert(market, review);
    outcome = 'opened';
  } else {
    const added = review.addReason({
      reason: input.reason,
      sample: input.sample ?? null,
      now: input.now,
    });
    if (!added.ok) throw new StaleAggregateError('offer-post-review', review.state.id);
    if (added.value) {
      if (!(await postReviews.save(market, review))) {
        throw new StaleAggregateError('offer-post-review', review.state.id);
      }
      outcome = 'extended';
    } else {
      outcome = 'unchanged';
    }
  }
  const fresh = await postReviews.receive(market, {
    ...key,
    postReviewId: review.state.id,
    receivedAt: input.now,
  });
  // Another unit received the same source in the meantime: roll back and ask again.
  if (!fresh) throw new StaleAggregateError('offer-post-review', review.state.id);
  return outcome;
}
