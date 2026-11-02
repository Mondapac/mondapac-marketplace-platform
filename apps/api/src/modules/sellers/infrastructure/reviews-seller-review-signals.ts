import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';
import type { ReviewsFacade } from '../../reviews';
import type { SellerReviewSignals } from '../application/ports/seller-review-signals';
import { localDayBounds } from '../domain/seller-health-days';

/**
 * {@link SellerReviewSignals} on the reviews facade: the published reviews of the seller in the
 * seller's local day, with the caller's context unchanged. Reviews off in the Market means no
 * reviews, so zeros; the health formula reads too few reviews (below the Market minimum) as
 * "no data" for the rating, never as a good or bad score. Any other refusal throws so the rollup
 * stores nothing for the day.
 */
export class ReviewsFacadeSellerReviewSignals implements SellerReviewSignals {
  constructor(private readonly reviews: ReviewsFacade) {}

  async day(
    context: CallContext,
    sellerId: Id<'Seller'>,
    day: Temporal.PlainDate,
    zone: string,
  ): Promise<{ readonly reviews: number; readonly starsSum: number }> {
    const { from, to } = localDayBounds(day, zone);
    const read = await this.reviews.sellerReviewCount(context, sellerId, from, to);
    if (read.ok) return read.value;
    if (read.error.code === 'reviews.disabled') return { reviews: 0, starsSum: 0 };
    throw new Error(`seller-health.reviews: ${read.error.code}`);
  }
}
