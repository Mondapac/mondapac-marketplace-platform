import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { WorkQueueCount } from '../../../platform/work-queue/work-queue-count';
import type { SecurityWorkQueueCountReader } from '../application/ports/work-queue-count.reader';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/**
 * {@link SecurityWorkQueueCountReader} over Prisma. The live alerts are those `open` or
 * `acknowledged` (the repository's LIVE states, the summary's), read on (market_id, state,
 * severity, opened_at); they entered the queue when opened.
 */
export class PrismaSecurityWorkQueueCountReader implements SecurityWorkQueueCountReader {
  constructor(private readonly prisma: PrismaService) {}

  async openAlerts(
    market: MarketContext,
    _now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount> {
    const alerts = this.prisma.tx(market).securityAlert;
    const where = { marketId: market.marketId, state: { in: ['open', 'acknowledged'] } };
    const [all, overdue] = await Promise.all([
      alerts.aggregate({ where, _count: { _all: true }, _min: { openedAt: true } }),
      alerts.count({ where: { ...where, openedAt: { lt: toDate(staleBefore) } } }),
    ]);
    const oldest = all._min.openedAt;
    return {
      count: all._count._all,
      overdue,
      oldestAt:
        all._count._all === 0 || oldest === null
          ? null
          : Temporal.Instant.fromEpochMilliseconds(oldest.getTime()),
    };
  }
}
