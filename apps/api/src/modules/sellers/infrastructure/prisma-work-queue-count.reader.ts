import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { WorkQueueCount } from '../../../platform/work-queue/work-queue-count';
import type { SellerHealthStore } from '../application/ports/seller-health.store';
import type { SellersWorkQueueCountReader } from '../application/ports/work-queue-count.reader';
import { SELLER_LIST_HEALTH_DAYS } from '../application/use-cases/list.use-case';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/**
 * {@link SellersWorkQueueCountReader} over Prisma. The seller files awaiting review are the
 * business-file revisions `pending` (one per seller at most: partial unique index on (market_id,
 * seller_id)), entered when created, as the "Awaiting review" tab sorts them. The health queue is
 * the store's own `unhealthy` read over the same days as the queue's list (the newest snapshot of
 * each seller unhealthy in the last {@link SELLER_LIST_HEALTH_DAYS} UTC days, up to the queue's
 * bound), so the dashboard and the list never disagree.
 */
export class PrismaSellersWorkQueueCountReader implements SellersWorkQueueCountReader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly healthStore: Pick<SellerHealthStore, 'unhealthy'>,
  ) {}

  async applications(
    market: MarketContext,
    _now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount> {
    const revisions = this.prisma.tx(market).sellersBusinessFileRevision;
    const where = { marketId: market.marketId, status: 'pending' };
    const [all, overdue] = await Promise.all([
      revisions.aggregate({ where, _count: { _all: true }, _min: { createdAt: true } }),
      revisions.count({ where: { ...where, createdAt: { lt: toDate(staleBefore) } } }),
    ]);
    const oldest = all._min.createdAt;
    return {
      count: all._count._all,
      overdue,
      oldestAt:
        all._count._all === 0 || oldest === null
          ? null
          : Temporal.Instant.fromEpochMilliseconds(oldest.getTime()),
    };
  }

  async unhealthySellers(
    market: MarketContext,
    now: Temporal.Instant,
    _staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount> {
    // The same window as the queue's list (readHealthQueue): the newest local date on Earth is at
    // most one day ahead of UTC.
    const today = now.toZonedDateTimeISO('UTC').toPlainDate();
    const found = await this.healthStore.unhealthy(
      market,
      today.subtract({ days: SELLER_LIST_HEALTH_DAYS - 1 }),
      today.add({ days: 1 }),
    );
    return { count: found.sellers.length, overdue: 0, oldestAt: null };
  }
}
