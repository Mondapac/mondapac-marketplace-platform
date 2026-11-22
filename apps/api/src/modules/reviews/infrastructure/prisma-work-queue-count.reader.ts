import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { WorkQueueCount } from '../../../platform/work-queue/work-queue-count';
import type { ReviewsWorkQueueCountReader } from '../application/ports/work-queue-count.reader';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/**
 * {@link ReviewsWorkQueueCountReader} over Prisma: one aggregate and one count, ids and times only
 * (never review text). The unanswered reviews are the seller Reviews list's `unanswered` view (the
 * same `where`: published, no published reply of this seller), on the partial index
 * `product_reviews_seller_published_idx` with the replies' (market_id, review_id) index.
 */
export class PrismaReviewsWorkQueueCountReader implements ReviewsWorkQueueCountReader {
  constructor(private readonly prisma: PrismaService) {}

  async sellerUnanswered(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount> {
    const reviews = this.prisma.tx(market).reviewsProductReview;
    const where = {
      marketId: market.marketId,
      sellerId,
      status: 'published',
      replies: { none: { sellerId, status: 'published' } },
    };
    const [all, overdue] = await Promise.all([
      reviews.aggregate({ where, _count: { _all: true }, _min: { publishedAt: true } }),
      reviews.count({ where: { ...where, publishedAt: { lt: toDate(staleBefore) } } }),
    ]);
    const count = all._count._all;
    const oldest = all._min.publishedAt;
    return {
      count,
      overdue,
      oldestAt:
        count === 0 || oldest === null
          ? null
          : Temporal.Instant.fromEpochMilliseconds(oldest.getTime()),
    };
  }
}
