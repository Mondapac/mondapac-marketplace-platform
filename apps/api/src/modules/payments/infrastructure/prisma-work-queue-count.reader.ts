import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { WorkQueueCount } from '../../../platform/work-queue/work-queue-count';
import {
  FAILED_WEBHOOK_WINDOW_HOURS,
  type PaymentsWorkQueueCountReader,
} from '../application/ports/work-queue-count.reader';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date | null, count: number): Temporal.Instant | null =>
  count === 0 || date === null ? null : Temporal.Instant.fromEpochMilliseconds(date.getTime());

/**
 * {@link PaymentsWorkQueueCountReader} over Prisma: one aggregate and one count per queue, ids and
 * times only (no amount, no account detail).
 * - Failed webhooks: the events still not applied since before the age limit (stuck or retrying;
 *   on `stripe_events_market_id_processed_at_next_attempt_at_idx`), and the events given up
 *   (`outcome = 'failed'`) received within the window (on the partial index of the failed ones).
 *   `rejected` events (a bad signature or an object of no interest) are not counted.
 * - Restricted accounts: the connected accounts in `restricted`, since their last update (the
 *   table holds one row per seller).
 * - Seller payouts blocked (seller tasks): the seller's own account row (its primary key) when it
 *   is restricted or its payouts are not enabled.
 */
export class PrismaPaymentsWorkQueueCountReader implements PaymentsWorkQueueCountReader {
  constructor(private readonly prisma: PrismaService) {}

  async failedWebhooks(
    market: MarketContext,
    now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount> {
    const events = this.prisma.tx(market).paymentsStripeEvent;
    const where = {
      marketId: market.marketId,
      OR: [
        { processedAt: null, receivedAt: { lt: toDate(staleBefore) } },
        {
          outcome: 'failed',
          receivedAt: { gte: toDate(now.subtract({ hours: FAILED_WEBHOOK_WINDOW_HOURS })) },
        },
      ],
    };
    const [all, overdue] = await Promise.all([
      events.aggregate({ where, _count: { _all: true }, _min: { receivedAt: true } }),
      events.count({ where: { ...where, receivedAt: { lt: toDate(staleBefore) } } }),
    ]);
    const count = all._count._all;
    return { count, overdue, oldestAt: toInstant(all._min.receivedAt, count) };
  }

  async restrictedAccounts(
    market: MarketContext,
    _now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount> {
    const accounts = this.prisma.tx(market).paymentsConnectedAccount;
    const where = { marketId: market.marketId, status: 'restricted' };
    const [all, overdue] = await Promise.all([
      accounts.aggregate({ where, _count: { _all: true }, _min: { updatedAt: true } }),
      accounts.count({ where: { ...where, updatedAt: { lt: toDate(staleBefore) } } }),
    ]);
    const count = all._count._all;
    return { count, overdue, oldestAt: toInstant(all._min.updatedAt, count) };
  }

  async sellerPayoutsBlocked(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<WorkQueueCount> {
    const account = await this.prisma.tx(market).paymentsConnectedAccount.findFirst({
      where: {
        marketId: market.marketId,
        sellerId,
        OR: [{ status: 'restricted' }, { payoutsEnabled: false }],
      },
      select: { updatedAt: true },
    });
    return account === null
      ? { count: 0, overdue: 0, oldestAt: null }
      : { count: 1, overdue: 0, oldestAt: toInstant(account.updatedAt, 1) };
  }
}
