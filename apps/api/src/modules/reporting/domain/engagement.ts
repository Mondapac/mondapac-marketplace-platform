import { Temporal } from '@mondapac/shared-kernel';
import { MIN_COUNT_BASE, ratioBp, rateDelta } from './admin-kpi';
import { marketDayOf, type MarketDay } from './facts';
import { delta, type DayRange, type Delta } from './period';

// The shopping funnel of the dashboards (dashboards v2, phase 2). One row per Market day, written
// once by the nightly snapshot from engagement's counts (signed-in customers with personalization
// on; guests never) and ordering's orders, and never changed: a customer's later opt-out or
// erasure leaves the row as it was, and the row names no one.

/** The four steps of a day, each a count of distinct signed-in customers within the step before. */
export interface EngagementDay {
  readonly day: MarketDay;
  readonly viewed: number;
  readonly carted: number;
  readonly checkedOut: number;
  readonly paid: number;
}

/** How far back the snapshot writes a missing day: inside the 30-day guest retention. */
export const SNAPSHOT_LOOKBACK_DAYS = 28;
/**
 * How long after a Market day ends its snapshot waits: the 30-minute payment window of an order
 * placed just before midnight, with a margin, so "paid" is settled when the row is written once.
 */
export const SNAPSHOT_SETTLE = Temporal.Duration.from({ hours: 2 });
/** A step with fewer distinct customers than this in the period is hidden (never shown as 0). */
export const MIN_FUNNEL_GROUP = 5;
/** Fewer viewers than this in the period: no rates at all; in the period before: no change. */
export const MIN_FUNNEL_BASE = 20;

/**
 * The Market days the snapshot should write at `now`: from {@link SNAPSHOT_LOOKBACK_DAYS} days
 * before the Market's today to yesterday, oldest first, each only once it ended at least
 * {@link SNAPSHOT_SETTLE} ago (in the Market's zone; a DST day is as long as it is there) and only
 * when it has no row yet.
 */
export function snapshotDaysDue(
  now: Temporal.Instant,
  zone: string,
  recorded: ReadonlySet<MarketDay>,
): MarketDay[] {
  const today = Temporal.PlainDate.from(marketDayOf(now, zone));
  const due: MarketDay[] = [];
  for (let back = SNAPSHOT_LOOKBACK_DAYS; back >= 1; back -= 1) {
    const day = today.subtract({ days: back });
    const end = day.add({ days: 1 }).toZonedDateTime({ timeZone: zone }).toInstant();
    if (Temporal.Instant.compare(end.add(SNAPSHOT_SETTLE), now) > 0) continue;
    const key = day.toString() as MarketDay;
    if (!recorded.has(key)) due.push(key);
  }
  return due;
}

/** The instants of one Market day in the zone: its start included, the next day's start excluded. */
export function dayWindowOf(
  day: MarketDay,
  zone: string,
): { readonly from: Temporal.Instant; readonly to: Temporal.Instant } {
  const date = Temporal.PlainDate.from(day);
  return {
    from: date.toZonedDateTime({ timeZone: zone }).toInstant(),
    to: date.add({ days: 1 }).toZonedDateTime({ timeZone: zone }).toInstant(),
  };
}

/** One step as the dashboard shows it. */
export interface FunnelStep {
  /** Customer-days of the period; null when hidden (fewer than {@link MIN_FUNNEL_GROUP}). */
  readonly count: number | null;
  /** This step ÷ the step before, basis points; null for the first step and when hidden. */
  readonly rateBp: number | null;
  /** The count against the period before; `na` below {@link MIN_FUNNEL_BASE} viewers there. */
  readonly change: Delta;
  /** The rate against the period before, in basis points of difference; `na` as above. */
  readonly rateChange: Delta;
}

/**
 * The shopping funnel of a period. Each count is the sum of the days' distinct customers, so a
 * customer who comes back on another day counts again (customer-days). `recordedDays` of the
 * `periodDays` have a row: today has none until its snapshot, the day after it ends.
 */
export type ShoppingFunnel =
  | {
      readonly status: 'not-enough-data';
      readonly minimum: number;
      readonly recordedDays: number;
      readonly periodDays: number;
    }
  | {
      readonly status: 'available';
      readonly viewed: FunnelStep;
      readonly carted: FunnelStep;
      readonly checkedOut: FunnelStep;
      readonly paid: FunnelStep;
      readonly recordedDays: number;
      readonly periodDays: number;
    };

type Totals = Omit<EngagementDay, 'day'>;

function totalsOf(days: readonly EngagementDay[]): Totals {
  const totals = { viewed: 0, carted: 0, checkedOut: 0, paid: 0 };
  for (const day of days) {
    const counts = [day.viewed, day.carted, day.checkedOut, day.paid];
    if (
      !counts.every((n) => Number.isSafeInteger(n) && n >= 0) ||
      day.carted > day.viewed ||
      day.checkedOut > day.carted ||
      day.paid > day.checkedOut
    ) {
      throw new RangeError('reporting: an engagement day whose steps do not nest');
    }
    totals.viewed += day.viewed;
    totals.carted += day.carted;
    totals.checkedOut += day.checkedOut;
    totals.paid += day.paid;
  }
  return totals;
}

const STEPS = ['viewed', 'carted', 'checkedOut', 'paid'] as const;
const NA: Delta = { value: 0, direction: 'flat', state: 'na' };

/**
 * The funnel of `current` against `previous` (the rows of each range; a day without a row adds
 * nothing). Below {@link MIN_FUNNEL_BASE} viewers it is `not-enough-data`: no step, no rate. A
 * step below {@link MIN_FUNNEL_GROUP} is hidden with its rate, and so is every step after it
 * (they can only be smaller), so no hidden count can be worked out from a rate.
 */
export function shoppingFunnelOf(
  current: readonly EngagementDay[],
  previous: readonly EngagementDay[],
  range: DayRange,
): ShoppingFunnel {
  const now = totalsOf(current);
  const before = totalsOf(previous);
  const periodDays =
    Temporal.PlainDate.from(range.from).until(Temporal.PlainDate.from(range.to)).days + 1;
  const recordedDays = new Set(current.map((day) => day.day)).size;
  if (now.viewed < MIN_FUNNEL_BASE) {
    return { status: 'not-enough-data', minimum: MIN_FUNNEL_BASE, recordedDays, periodDays };
  }
  const visible = (n: number) => n >= MIN_FUNNEL_GROUP;
  const baseIsEnough = before.viewed >= MIN_FUNNEL_BASE;
  const rate = (totals: Totals, index: number): number | null => {
    if (index === 0) return null;
    const step = totals[STEPS[index]!];
    const base = totals[STEPS[index - 1]!];
    return visible(step) && visible(base) ? ratioBp(step, base) : null;
  };
  const step = (index: number): FunnelStep => {
    const count = now[STEPS[index]!];
    if (!visible(count)) return { count: null, rateBp: null, change: NA, rateChange: NA };
    const rateNow = rate(now, index);
    const rateBefore = rate(before, index);
    return {
      count,
      rateBp: rateNow,
      change: baseIsEnough ? delta(count, before[STEPS[index]!], MIN_COUNT_BASE) : NA,
      rateChange: rateDelta(rateNow, rateBefore, baseIsEnough),
    };
  };
  return {
    status: 'available',
    viewed: step(0),
    carted: step(1),
    checkedOut: step(2),
    paid: step(3),
    recordedDays,
    periodDays,
  };
}
