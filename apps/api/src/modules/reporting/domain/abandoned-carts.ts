import { Temporal } from '@mondapac/shared-kernel';
import type { Money } from '@mondapac/shared-kernel';
import { MIN_COUNT_BASE } from './admin-kpi';
import { SNAPSHOT_SETTLE } from './engagement';
import { marketDayOf, type MarketDay } from './facts';
import { delta, type DayRange, type Delta } from './period';

// Abandoned carts of the dashboards (dashboards v2, phase 2). One row per Market day, written once
// by the nightly snapshot from cart's totals and never changed. It is a level, not a flow: the
// carts that were left at the end of the day, so a period shows its latest day, never a sum.
// The row names no one: a count and an approximate value only.

/** A cart untouched for at least this long at the end of a Market day counts as abandoned. */
export const ABANDONED_AFTER = Temporal.Duration.from({ hours: 24 });
/** Fewer carts than this on the latest day: no count and no value (one cart is one person's). */
export const MIN_ABANDONED_CARTS = 5;

/** One Market day's snapshot. */
export interface AbandonedCartsDay {
  readonly day: MarketDay;
  /** Active carts with lines, not left by a paid order, untouched for 24 hours at the day's end. */
  readonly carts: number;
  /**
   * The lines at the price when each was added or last changed, in the Market's currency:
   * approximate (prices change). Null when a line was in another currency (no conversion).
   */
  readonly value: Money | null;
}

/**
 * The Market day the snapshot should write at `now`: yesterday in the Market's zone, once it ended
 * at least {@link SNAPSHOT_SETTLE} ago and only while it has no row. Unlike the funnel, an older
 * day is never written late: a cart's state is read as it is now, so a day missed while the worker
 * was down stays without a row rather than getting another day's carts.
 */
export function abandonedCartsDayDue(
  now: Temporal.Instant,
  zone: string,
  recorded: boolean,
): MarketDay | null {
  if (recorded) return null;
  const today = Temporal.PlainDate.from(marketDayOf(now, zone));
  const end = today.toZonedDateTime({ timeZone: zone }).toInstant();
  if (Temporal.Instant.compare(end.add(SNAPSHOT_SETTLE), now) > 0) return null;
  return today.subtract({ days: 1 }).toString() as MarketDay;
}

/** The last change a cart may have to count for `day`: 24 hours before the day's end, in its zone. */
export function idleCutoffOf(day: MarketDay, zone: string): Temporal.Instant {
  return Temporal.PlainDate.from(day)
    .add({ days: 1 })
    .toZonedDateTime({ timeZone: zone })
    .toInstant()
    .subtract(ABANDONED_AFTER);
}

/**
 * The approximate value in the Market's `currency` from cart's totals per currency: zero with no
 * line, null when any line is in another currency (there is no conversion, and a part would mislead).
 */
export function approximateValueOf(totals: readonly Money[], currency: string): Money | null {
  let amount = 0n;
  for (const total of totals) {
    if (total.amount < 0n) throw new RangeError('reporting: a negative abandoned-cart total');
    if (total.currency !== currency) return null;
    amount += total.amount;
  }
  return { amount, currency };
}

/**
 * Abandoned carts as the dashboard shows them. `asOfDay` is the latest day of the period with a
 * row; `recordedDays` of the `periodDays` have a row (today has none until tomorrow's snapshot).
 */
export type AbandonedCarts =
  | {
      readonly status: 'not-enough-data';
      readonly minimum: number;
      readonly recordedDays: number;
      readonly periodDays: number;
    }
  | {
      readonly status: 'available';
      readonly carts: number;
      /** Approximate: the prices when the lines were added. Null with mixed currencies. */
      readonly approximateValue: Money | null;
      readonly asOfDay: MarketDay;
      /** The count against the latest day of the period before; `na` below five carts there. */
      readonly change: Delta;
      readonly recordedDays: number;
      readonly periodDays: number;
    };

const NA: Delta = { value: 0, direction: 'flat', state: 'na' };

function latestOf(days: readonly AbandonedCartsDay[]): AbandonedCartsDay | null {
  let latest: AbandonedCartsDay | null = null;
  for (const day of days) {
    if (!Number.isSafeInteger(day.carts) || day.carts < 0) {
      throw new RangeError('reporting: an abandoned-cart day with a bad count');
    }
    if (latest === null || day.day > latest.day) latest = day;
  }
  return latest;
}

/**
 * The period's abandoned carts: its latest day against the latest day of the period before. Below
 * {@link MIN_ABANDONED_CARTS} carts (or with no row) it is `not-enough-data`: no count, no value.
 */
export function abandonedCartsOf(
  current: readonly AbandonedCartsDay[],
  previous: readonly AbandonedCartsDay[],
  range: DayRange,
): AbandonedCarts {
  const latest = latestOf(current);
  const before = latestOf(previous);
  const periodDays =
    Temporal.PlainDate.from(range.from).until(Temporal.PlainDate.from(range.to)).days + 1;
  const recordedDays = new Set(current.map((day) => day.day)).size;
  if (latest === null || latest.carts < MIN_ABANDONED_CARTS) {
    return { status: 'not-enough-data', minimum: MIN_ABANDONED_CARTS, recordedDays, periodDays };
  }
  return {
    status: 'available',
    carts: latest.carts,
    approximateValue: latest.value,
    asOfDay: latest.day,
    change:
      before !== null && before.carts >= MIN_ABANDONED_CARTS
        ? delta(latest.carts, before.carts, MIN_COUNT_BASE)
        : NA,
    recordedDays,
    periodDays,
  };
}
