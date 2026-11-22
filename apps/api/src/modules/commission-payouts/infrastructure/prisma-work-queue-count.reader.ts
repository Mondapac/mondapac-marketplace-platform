import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { WorkQueueCount } from '../../../platform/work-queue/work-queue-count';
import {
  DISPUTE_DUE_WITHIN_HOURS,
  FAILED_PAYOUT_WINDOW_HOURS,
  type CommissionPayoutsWorkQueueCountReader,
} from '../application/ports/work-queue-count.reader';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date | null, count: number): Temporal.Instant | null =>
  count === 0 || date === null ? null : Temporal.Instant.fromEpochMilliseconds(date.getTime());

/**
 * {@link CommissionPayoutsWorkQueueCountReader} over Prisma: one aggregate and one count per
 * queue, ids and times only (no amount).
 * - Failed payouts: state `failed` (the admin Payouts list's `failed` bucket) that failed within
 *   the window, on (market_id, state, created_at, id).
 * - Payout holds: every active hold (`released_at IS NULL`, the partial
 *   `payout_holds_active_seller_idx`), since it was placed.
 * - Disputes due: the cases in the `needs-response` bucket whose response is due before
 *   `now` + 24 hours, past due included, on `dispute_cases_bucket_idx`; a case without a deadline
 *   is not counted. Overdue: the deadline has passed; the oldest is the nearest deadline.
 */
export class PrismaCommissionPayoutsWorkQueueCountReader implements CommissionPayoutsWorkQueueCountReader {
  constructor(private readonly prisma: PrismaService) {}

  async failedPayouts(
    market: MarketContext,
    now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount> {
    const payouts = this.prisma.tx(market).commissionPayoutsPayout;
    const where = {
      marketId: market.marketId,
      state: 'failed',
      stateChangedAt: { gte: toDate(now.subtract({ hours: FAILED_PAYOUT_WINDOW_HOURS })) },
    };
    const [all, overdue] = await Promise.all([
      payouts.aggregate({ where, _count: { _all: true }, _min: { stateChangedAt: true } }),
      payouts.count({
        where: {
          ...where,
          stateChangedAt: { ...where.stateChangedAt, lt: toDate(staleBefore) },
        },
      }),
    ]);
    const count = all._count._all;
    return { count, overdue, oldestAt: toInstant(all._min.stateChangedAt, count) };
  }

  async payoutHolds(
    market: MarketContext,
    _now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount> {
    const holds = this.prisma.tx(market).commissionPayoutsPayoutHold;
    const where = { marketId: market.marketId, releasedAt: null };
    const [all, overdue] = await Promise.all([
      holds.aggregate({ where, _count: { _all: true }, _min: { placedAt: true } }),
      holds.count({ where: { ...where, placedAt: { lt: toDate(staleBefore) } } }),
    ]);
    const count = all._count._all;
    return { count, overdue, oldestAt: toInstant(all._min.placedAt, count) };
  }

  async disputesDue(market: MarketContext, now: Temporal.Instant): Promise<WorkQueueCount> {
    const cases = this.prisma.tx(market).commissionPayoutsDisputeCase;
    const where = {
      marketId: market.marketId,
      bucket: 'needs-response',
      evidenceDueBy: { lt: toDate(now.add({ hours: DISPUTE_DUE_WITHIN_HOURS })) },
    };
    const [all, overdue] = await Promise.all([
      cases.aggregate({ where, _count: { _all: true }, _min: { evidenceDueBy: true } }),
      cases.count({ where: { ...where, evidenceDueBy: { lt: toDate(now) } } }),
    ]);
    const count = all._count._all;
    return { count, overdue, oldestAt: toInstant(all._min.evidenceDueBy, count) };
  }
}
