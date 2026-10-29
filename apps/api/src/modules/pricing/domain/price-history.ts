import { Temporal } from '@mondapac/shared-kernel';
import type { Money } from '@mondapac/shared-kernel';
import { effectivePriceAt } from './price-series';
import type { PriceSeriesState } from './price-series';
import { isSpecialPriced, specialEnd } from './special-price';

const DAY_MS = 86_400_000;

/**
 * How many whole days of `[from, to)` the series' effective price (pricing design 4.1: the
 * special in force when below the regular in force, else the regular) was exactly `price`: the
 * fact behind promotions' was-price rule. The time at that price is summed over the window and
 * floored to whole days of 24 hours, so a window in no zone is measured the same in every Market
 * (a part day never counts). Only records that were in force count: pending, rejected and
 * superseded-before-effect records never do, so the answer is the price buyers saw. A retired
 * series counts until its retirement. Another currency is never the same price: 0.
 */
export function daysAtPrice(
  state: PriceSeriesState,
  price: Money,
  from: Temporal.Instant,
  to: Temporal.Instant,
): number {
  if (Temporal.Instant.compare(from, to) >= 0) return 0;
  if (price.currency !== state.currency) return 0;
  // The effective price changes only at a record's boundary or at retirement, so it is constant
  // between two consecutive boundaries and read once at each segment's start.
  const cuts = new Map<number, Temporal.Instant>([
    [from.epochMilliseconds, from],
    [to.epochMilliseconds, to],
  ]);
  const cut = (at: Temporal.Instant | null): void => {
    if (at === null) return;
    if (Temporal.Instant.compare(at, from) <= 0 || Temporal.Instant.compare(at, to) >= 0) return;
    cuts.set(at.epochMilliseconds, at);
  };
  for (const record of state.regular) {
    cut(record.effectiveFrom);
    cut(record.effectiveTo);
  }
  for (const record of state.specials) {
    if (!isSpecialPriced(record)) continue;
    cut(record.effectiveFrom);
    cut(specialEnd(record));
  }
  cut(state.retiredAt);
  // `effectivePriceAt` answers null for every instant of a retired series; before its retirement
  // the series was live, so the instants before it are read on the live state.
  const live: PriceSeriesState = { ...state, retiredAt: null };
  const ordered = [...cuts.values()].sort((a, b) => Temporal.Instant.compare(a, b));
  let atPriceMs = 0;
  for (let i = 0; i + 1 < ordered.length; i += 1) {
    const start = ordered[i] as Temporal.Instant;
    const end = ordered[i + 1] as Temporal.Instant;
    if (state.retiredAt !== null && Temporal.Instant.compare(start, state.retiredAt) >= 0) break;
    const effective = effectivePriceAt(live, start);
    if (effective === null) continue;
    if (effective.amount.currency !== price.currency) continue;
    if (effective.amount.amount !== price.amount) continue;
    atPriceMs += end.epochMilliseconds - start.epochMilliseconds;
  }
  return Math.floor(atPriceMs / DAY_MS);
}
