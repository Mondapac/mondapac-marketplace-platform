import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { OfferQueueBacklogRepository } from '../application/ports/offer-queue-backlog.repository';
import type { OfferQueueBacklogReason } from '../domain/offer-queue-backlog';

const date = (at: Temporal.Instant) => new Date(at.epochMilliseconds);

/**
 * {@link OfferQueueBacklogRepository} on `notifications.offer_queue_backlog_alerts`, scoped by
 * `marketId`. The partial unique index on open alerts turns a second open alert into a skipped
 * duplicate, so `raise` is true for one caller only.
 */
export class PrismaOfferQueueBacklogRepository implements OfferQueueBacklogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async raise(
    market: MarketContext,
    at: Temporal.Instant,
    reason: OfferQueueBacklogReason,
    queueSize: number,
  ) {
    const { count } = await this.prisma.tx(market).notificationsOfferQueueBacklogAlert.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          raisedAt: date(at),
          reason,
          queueSize,
        },
      ],
      skipDuplicates: true,
    });
    return count === 1;
  }

  async clear(market: MarketContext, at: Temporal.Instant) {
    const { count } = await this.prisma.tx(market).notificationsOfferQueueBacklogAlert.updateMany({
      where: { marketId: market.marketId, clearedAt: null },
      data: { clearedAt: date(at) },
    });
    return count > 0;
  }
}
