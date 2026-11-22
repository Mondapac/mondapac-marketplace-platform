import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { WorkQueueCount } from '../../../platform/work-queue/work-queue-count';
import type { WorkQueueCountReader } from '../application/ports/work-queue-count.reader';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const earliest = (instants: readonly (Temporal.Instant | null)[]): Temporal.Instant | null =>
  instants.reduce<Temporal.Instant | null>(
    (first, at) =>
      at === null ? first : first === null || Temporal.Instant.compare(at, first) < 0 ? at : first,
    null,
  );

/**
 * {@link WorkQueueCountReader} over Prisma. The not-ready orders read the to-ship partial index
 * (`fulfilment = 'to-ship'`, small by nature); their ready-by time is `paid_at` plus the frozen
 * minutes, so they are counted once per distinct number of minutes (a handful per Market: one
 * per delivery method's setting). Scheduled orders not delivered are counted on the window end.
 */
export class PrismaWorkQueueCountReader implements WorkQueueCountReader {
  constructor(private readonly prisma: PrismaService) {}

  async lateDeliveries(
    market: MarketContext,
    now: Temporal.Instant,
    overdueBefore: Temporal.Instant,
  ): Promise<WorkQueueCount> {
    const orders = this.prisma.tx(market).orderingSellerOrder;
    const notReady = {
      marketId: market.marketId,
      tenantId: market.tenantId,
      paidAt: { not: null },
      fulfilment: 'to-ship',
      readyAt: null,
      refundedInFull: false,
      deliveryMethod: { not: 'scheduled' },
      readyPrepMinutes: { not: null },
    } as const;
    const scheduled = {
      marketId: market.marketId,
      tenantId: market.tenantId,
      paidAt: { not: null },
      fulfilment: { in: ['to-ship', 'shipped'] as string[] },
      refundedInFull: false,
      deliveryMethod: 'scheduled',
      deliveryWindowEnd: { not: null },
    } as const;
    const [minutes, windowLate, windowOverdue] = await Promise.all([
      orders.groupBy({ by: ['readyPrepMinutes'], where: notReady }),
      orders.aggregate({
        where: { ...scheduled, deliveryWindowEnd: { lt: toDate(now) } },
        _count: { _all: true },
        _min: { deliveryWindowEnd: true },
      }),
      orders.count({ where: { ...scheduled, deliveryWindowEnd: { lt: toDate(overdueBefore) } } }),
    ]);
    const perMinutes = await Promise.all(
      minutes.map(async ({ readyPrepMinutes }) => {
        const prep = readyPrepMinutes ?? 0;
        const where = (before: Temporal.Instant) => ({
          ...notReady,
          readyPrepMinutes: prep,
          paidAt: { lt: toDate(before.subtract({ minutes: prep })) },
        });
        const [late, overdue] = await Promise.all([
          orders.aggregate({ where: where(now), _count: { _all: true }, _min: { paidAt: true } }),
          orders.count({ where: where(overdueBefore) }),
        ]);
        const paid = late._min.paidAt;
        return {
          count: late._count._all,
          overdue,
          oldestAt: paid === null ? null : toInstant(paid).add({ minutes: prep }),
        };
      }),
    );
    const windowEnd = windowLate._min.deliveryWindowEnd;
    const parts = [
      ...perMinutes,
      {
        count: windowLate._count._all,
        overdue: windowOverdue,
        oldestAt: windowEnd === null ? null : toInstant(windowEnd),
      },
    ].filter((part) => part.count > 0);
    return {
      count: parts.reduce((n, part) => n + part.count, 0),
      overdue: parts.reduce((n, part) => n + part.overdue, 0),
      oldestAt: earliest(parts.map((part) => part.oldestAt)),
    };
  }

  async pendingRefunds(
    market: MarketContext,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount> {
    const refunds = this.prisma.tx(market).orderingRefund;
    const pending = { marketId: market.marketId, tenantId: market.tenantId, state: 'pending' };
    const [all, overdue] = await Promise.all([
      refunds.aggregate({ where: pending, _count: { _all: true }, _min: { requestedAt: true } }),
      refunds.count({ where: { ...pending, requestedAt: { lt: toDate(staleBefore) } } }),
    ]);
    const oldest = all._min.requestedAt;
    return {
      count: all._count._all,
      overdue,
      oldestAt: oldest === null || all._count._all === 0 ? null : toInstant(oldest),
    };
  }
}
