import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { WorkQueueCount } from '../../../platform/work-queue/work-queue-count';
import type { PricingWorkQueueCountReader } from '../application/ports/work-queue-count.reader';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/**
 * {@link PricingWorkQueueCountReader} over Prisma. The held changes are the regular and special
 * price records `pending-review` (as `countPendingHolds`), each read on its partial index
 * (market_id, submitted_at, id) WHERE status = 'pending-review'. Only counts and submission
 * times are read: never a price or a Cost (pricing design 6.5).
 */
export class PrismaPricingWorkQueueCountReader implements PricingWorkQueueCountReader {
  constructor(private readonly prisma: PrismaService) {}

  async priceHolds(
    market: MarketContext,
    _now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount> {
    const tx = this.prisma.tx(market);
    const where = { marketId: market.marketId, status: 'pending-review' };
    const stale = { ...where, submittedAt: { lt: toDate(staleBefore) } };
    const [regular, special, regularOverdue, specialOverdue] = await Promise.all([
      tx.pricingRegularPriceRecord.aggregate({
        where,
        _count: { _all: true },
        _min: { submittedAt: true },
      }),
      tx.pricingSpecialPriceRecord.aggregate({
        where,
        _count: { _all: true },
        _min: { submittedAt: true },
      }),
      tx.pricingRegularPriceRecord.count({ where: stale }),
      tx.pricingSpecialPriceRecord.count({ where: stale }),
    ]);
    const firsts = [regular._min.submittedAt, special._min.submittedAt].filter(
      (at): at is Date => at !== null,
    );
    const count = regular._count._all + special._count._all;
    const oldest = firsts.length === 0 ? null : Math.min(...firsts.map((at) => at.getTime()));
    return {
      count,
      overdue: regularOverdue + specialOverdue,
      oldestAt:
        count === 0 || oldest === null ? null : Temporal.Instant.fromEpochMilliseconds(oldest),
    };
  }
}
