import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';
import type { ReviewsFacade } from '../../reviews';
import type { SellerReviewSignals } from '../application/ports/seller-review-signals';
import { localDayBounds } from '../domain/seller-health-days';

/**
 * {@link SellerReviewSignals} on the reviews facade: the published reviews of the seller in each
 * of the seller's local days, in one call, with the caller's context unchanged. Reviews off in the
 * Market means no reviews, so zeros (the health formula reads too few reviews as "no data" for
 * the rating, never as a good or bad score). Any other refusal throws so the rollup stores nothing
 * for those days.
 */
export class ReviewsFacadeSellerReviewSignals implements SellerReviewSignals {
  constructor(private readonly reviews: ReviewsFacade) {}

  async days(
    context: CallContext,
    sellerId: Id<'Seller'>,
    days: readonly Temporal.PlainDate[],
    zone: string,
  ): Promise<readonly { readonly reviews: number; readonly starsSum: number }[]> {
    const windows = days.map((day) => localDayBounds(day, zone));
    const read = await this.reviews.sellerReviewCounts(context, sellerId, windows);
    if (read.ok) return read.value;
    if (read.error.code === 'reviews.disabled')
      return days.map(() => ({ reviews: 0, starsSum: 0 }));
    throw new Error(`seller-health.reviews: ${read.error.code}`);
  }
}
