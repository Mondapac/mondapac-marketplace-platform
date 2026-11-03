import type { CallContext, Clock, Id, Temporal } from '@mondapac/shared-kernel';
import { computeSellerHealth } from '../../domain/seller-health';
import {
  sellerHealthInputFromDays,
  windowStart,
  type SellerHealthDay,
} from '../../domain/seller-health-days';
import type { SellerHealthPolicy } from '../ports/seller-health-policy';
import type { SellerHealthSignals } from '../ports/seller-health-signals';
import type { SellerHealthSnapshot, SellerHealthStore } from '../ports/seller-health.store';

/** How many local days the nightly run counts again: today and the two before it (owner decision). */
export const SELLER_HEALTH_RECOUNT_DAYS = 3;

/** The dates the nightly run recounts for a seller whose local date is `today`, oldest first. */
export function recountDates(today: Temporal.PlainDate): readonly Temporal.PlainDate[] {
  return Array.from({ length: SELLER_HEALTH_RECOUNT_DAYS }, (_, index) =>
    today.subtract({ days: SELLER_HEALTH_RECOUNT_DAYS - 1 - index }),
  );
}

/**
 * Step 1, the reads: counts the recount dates of one seller from the feeds, one read per source
 * for all the dates. It opens units of its own through the facades, so it runs outside the write
 * unit; a failed feed throws and nothing is stored. `today` is the seller's local date and `zone`
 * the seller's IANA zone.
 */
export function countSellerHealthDays(
  signals: SellerHealthSignals,
  context: CallContext,
  sellerId: Id<'Seller'>,
  today: Temporal.PlainDate,
  zone: string,
): Promise<readonly SellerHealthDay[]> {
  return signals.days(context, sellerId, recountDates(today), zone);
}

export interface SellerHealthStoreDependencies {
  readonly store: SellerHealthStore;
  readonly policy: SellerHealthPolicy;
  readonly clock: Clock;
}

/**
 * Step 2, the writes: replaces the stored rows of the counted days, then sums the windows ending
 * `today` and stores the score and its snapshot. Counting again replaces a row, so a repeat or a
 * recalculation never counts twice. Health never acts on a seller: this writes numbers and
 * nothing else (R2). Runs in the caller's open read-write unit.
 */
export async function storeSellerHealth(
  deps: SellerHealthStoreDependencies,
  context: CallContext,
  sellerId: Id<'Seller'>,
  today: Temporal.PlainDate,
  counted: readonly SellerHealthDay[],
): Promise<SellerHealthSnapshot> {
  const { thresholds, windows } = await deps.policy.settings(context.market);
  const now = deps.clock.now();
  for (const day of counted) await deps.store.saveDay(context.market, sellerId, day, now);
  const days = await deps.store.days(
    context.market,
    sellerId,
    windowStart(today, windows.longDays),
    today,
  );
  const inputs = sellerHealthInputFromDays(days, today, windows);
  const snapshot: SellerHealthSnapshot = {
    day: today,
    health: computeSellerHealth(inputs, thresholds),
    inputs,
    computedAt: now,
  };
  await deps.store.saveSnapshot(context.market, sellerId, snapshot);
  return snapshot;
}
