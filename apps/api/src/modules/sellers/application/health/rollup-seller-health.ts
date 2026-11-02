import type { CallContext, Clock, Id, Temporal } from '@mondapac/shared-kernel';
import { computeSellerHealth } from '../../domain/seller-health';
import { windowStart } from '../../domain/seller-health-days';
import { sellerHealthInputFromDays } from '../../domain/seller-health-days';
import type { SellerHealthPolicy } from '../ports/seller-health-policy';
import type { SellerHealthSignals } from '../ports/seller-health-signals';
import type { SellerHealthSnapshot, SellerHealthStore } from '../ports/seller-health.store';

export interface SellerHealthRollupDependencies {
  readonly store: SellerHealthStore;
  readonly signals: SellerHealthSignals;
  readonly policy: SellerHealthPolicy;
  readonly clock: Clock;
}

/**
 * Recounts one local day of a seller and recomputes its score (the nightly job and the "Recalculate
 * now" and "Refresh now" actions call it; the job, the use cases and their access rules come in a
 * later package). `today` is the seller's local date and `zone` the seller's IANA zone. The day is
 * counted again from the feeds and replaces the stored row, then the windows ending today are
 * summed and the score and its snapshot are stored. Health never acts on a seller: this writes
 * numbers and nothing else (R2). Runs in the caller's open read-write unit.
 */
export async function rollupSellerHealth(
  deps: SellerHealthRollupDependencies,
  context: CallContext,
  sellerId: Id<'Seller'>,
  today: Temporal.PlainDate,
  zone: string,
): Promise<SellerHealthSnapshot> {
  const { thresholds, windows } = await deps.policy.settings(context.market);
  const counted = await deps.signals.day(context, sellerId, today, zone);
  const now = deps.clock.now();
  await deps.store.saveDay(context.market, sellerId, { ...counted, day: today }, now);
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
