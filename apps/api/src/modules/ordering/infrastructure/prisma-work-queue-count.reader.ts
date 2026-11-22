import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { WorkQueueCount } from '../../../platform/work-queue/work-queue-count';
import {
  FAILED_PAYMENT_REASONS,
  FAILED_PAYMENT_WINDOW_HOURS,
  type WorkQueueCountReader,
} from '../application/ports/work-queue-count.reader';

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
 * {@link WorkQueueCountReader} over Prisma (the late rule is documented on the port). The
 * not-ready orders read the to-ship partial index (`fulfilment = 'to-ship'`, small by nature);
 * their ready-by time is `paid_at` plus the frozen minutes, so they are counted once per distinct
 * number of minutes. Kept in Prisma rather than one raw statement (ADR-0030's reviewed list): the
 * distinct values among open orders are a handful per Market (one per delivery method's setting,
 * plus the values a setting held before it changed), and a read-only unit opens no transaction
 * (ADR-0025), so those counts run side by side. The scheduled orders not delivered read the
 * partial index on (market_id, delivery_window_end) of the open scheduled orders.
 */
export class PrismaWorkQueueCountReader implements WorkQueueCountReader {
  constructor(private readonly prisma: PrismaService) {}

  async lateDeliveries(
    market: MarketContext,
    now: Temporal.Instant,
    overdueBefore: Temporal.Instant,
    signal: AbortSignal,
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
      fulfilment: { not: 'delivered' },
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
    if (signal.aborted) throw new Error('The dashboard stopped waiting');
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

  async failedPayments(
    market: MarketContext,
    now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount> {
    const orders = this.prisma.tx(market).orderingOrder;
    const since = now.subtract({ hours: FAILED_PAYMENT_WINDOW_HOURS });
    const failed = {
      marketId: market.marketId,
      tenantId: market.tenantId,
      status: 'cancelled',
      cancelReason: { in: [...FAILED_PAYMENT_REASONS] },
      cancelledAt: { gte: toDate(since) },
    };
    const [all, overdue] = await Promise.all([
      orders.aggregate({ where: failed, _count: { _all: true }, _min: { cancelledAt: true } }),
      orders.count({
        where: { ...failed, cancelledAt: { gte: toDate(since), lt: toDate(staleBefore) } },
      }),
    ]);
    const oldest = all._min.cancelledAt;
    return {
      count: all._count._all,
      overdue,
      oldestAt: oldest === null || all._count._all === 0 ? null : toInstant(oldest),
    };
  }
}
