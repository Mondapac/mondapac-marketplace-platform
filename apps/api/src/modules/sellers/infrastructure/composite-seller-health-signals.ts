import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';
import type { SellerDisputeSignals } from '../application/ports/seller-dispute-signals';
import type { SellerHealthSignals } from '../application/ports/seller-health-signals';
import type { SellerOrderSignals } from '../application/ports/seller-order-signals';
import type { SellerReviewSignals } from '../application/ports/seller-review-signals';
import type { SellerHealthDay } from '../domain/seller-health-days';

/**
 * {@link SellerHealthSignals} from the three feeds: one read of each for all the days, then the
 * answers are laid side by side by position. A feed that answers a different number of days than
 * asked is a fault, never a count to use.
 */
export class CompositeSellerHealthSignals implements SellerHealthSignals {
  constructor(
    private readonly orders: SellerOrderSignals,
    private readonly reviews: SellerReviewSignals,
    private readonly disputes: SellerDisputeSignals,
  ) {}

  async days(
    context: CallContext,
    sellerId: Id<'Seller'>,
    days: readonly Temporal.PlainDate[],
    zone: string,
  ): Promise<readonly SellerHealthDay[]> {
    const orders = await this.orders.days(context, sellerId, days, zone);
    const reviews = await this.reviews.days(context, sellerId, days, zone);
    const disputes = await this.disputes.days(context, sellerId, days, zone);
    if (
      orders.length !== days.length ||
      reviews.length !== days.length ||
      disputes.length !== days.length
    ) {
      throw new Error('seller-health.signals: a feed answered the wrong number of days');
    }
    return days.map((day, index) => ({
      day,
      paidOrders: orders[index]!.paid,
      readyOrders: orders[index]!.ready,
      lateReadyOrders: orders[index]!.lateReady,
      lostDisputes: disputes[index]!.lost,
      reviewsApproved: reviews[index]!.reviews,
      ratingStarsSum: reviews[index]!.starsSum,
    }));
  }
}
