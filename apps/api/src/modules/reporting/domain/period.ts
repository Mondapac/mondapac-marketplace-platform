import { Temporal } from '@mondapac/shared-kernel';
import type { MarketDay } from './facts';

/** The periods a dashboard offers (design section 2 and 3). */
export const PERIOD_IDS = ['today', '7d', '30d', 'month'] as const;
export type PeriodId = (typeof PERIOD_IDS)[number];

export const isPeriodId = (value: unknown): value is PeriodId =>
  typeof value === 'string' && (PERIOD_IDS as readonly string[]).includes(value);

/** An inclusive range of Market days. */
export interface DayRange {
  readonly from: MarketDay;
  readonly to: MarketDay;
}

export interface ResolvedPeriod {
  readonly id: PeriodId;
  readonly current: DayRange;
  /** The period it is compared with: as many days, just before `current`. */
  readonly previous: DayRange;
  /** Days in `current` (the previous period has as many, or fewer for a short month). */
  readonly days: number;
}

const plain = (day: MarketDay): Temporal.PlainDate => Temporal.PlainDate.from(day);
const asDay = (date: Temporal.PlainDate): MarketDay => date.toString() as MarketDay;

/**
 * The current and the previous range of a period, counted in Market days and ending on `today`
 * (the Market's day, never the UTC day):
 * - `today`: today against yesterday.
 * - `7d` and `30d`: the last 7 or 30 days including today, against the 7 or 30 days before.
 * - `month`: the first of this month through today, against the same number of days from the
 *   first of the previous month (cut at its end when it is shorter), so the comparison is fair
 *   at any point of the month.
 */
export function resolvePeriod(id: PeriodId, today: MarketDay): ResolvedPeriod {
  const end = plain(today);
  if (id === 'month') {
    const start = end.with({ day: 1 });
    const days = end.day;
    const previousStart = start.subtract({ months: 1 });
    const previousEnd = previousStart.add({ days: days - 1 });
    const lastOfPrevious = start.subtract({ days: 1 });
    const cut =
      Temporal.PlainDate.compare(previousEnd, lastOfPrevious) > 0 ? lastOfPrevious : previousEnd;
    return {
      id,
      current: { from: asDay(start), to: today },
      previous: { from: asDay(previousStart), to: asDay(cut) },
      days,
    };
  }
  const days = id === 'today' ? 1 : id === '7d' ? 7 : 30;
  const start = end.subtract({ days: days - 1 });
  return {
    id,
    current: { from: asDay(start), to: today },
    previous: {
      from: asDay(start.subtract({ days })),
      to: asDay(start.subtract({ days: 1 })),
    },
    days,
  };
}

/** Every day of a range, oldest first. */
export function daysOf(range: DayRange): MarketDay[] {
  const days: MarketDay[] = [];
  let day = plain(range.from);
  const last = plain(range.to);
  while (Temporal.PlainDate.compare(day, last) <= 0) {
    days.push(asDay(day));
    day = day.add({ days: 1 });
  }
  return days;
}

export interface Delta {
  /** The change in basis points (1250 is +12.5%); 0 when `state` is `na`. */
  readonly value: number;
  readonly direction: 'up' | 'down' | 'flat';
  /** `na`: the base is zero or smaller than `minBase`, so a percentage would mislead. */
  readonly state: 'ok' | 'na';
}

const NA: Delta = { value: 0, direction: 'flat', state: 'na' };

/**
 * The change of `current` against `previous` (money in minor units or counts). A base of zero, or
 * below `minBase` (default 1), is `na`. Whether a rise is good or bad is for the panel to say.
 */
export function delta(
  current: bigint | number,
  previous: bigint | number,
  minBase: bigint | number = 1,
): Delta {
  const now = BigInt(current);
  const before = BigInt(previous);
  const base = before < 0n ? -before : before;
  if (base === 0n || base < BigInt(minBase)) return NA;
  const basisPoints = Number(((now - before) * 10000n) / base);
  const change = before < 0n ? -basisPoints : basisPoints;
  return {
    value: change,
    direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
    state: 'ok',
  };
}

/** The instants a range of Market days covers: `from` included, `to` excluded. */
export interface InstantWindow {
  readonly from: Temporal.Instant;
  readonly to: Temporal.Instant;
}

/**
 * The instants of a range of Market days in the Market's IANA zone: from the start of its first
 * day to the start of the day after its last (a DST day is as long as it is there). For a count
 * another module keeps by instant (the dispute rate's chargebacks), so it covers the same days.
 */
export function windowOf(range: DayRange, zone: string): InstantWindow {
  const start = (day: Temporal.PlainDate) => day.toZonedDateTime({ timeZone: zone }).toInstant();
  return { from: start(plain(range.from)), to: start(plain(range.to).add({ days: 1 })) };
}
