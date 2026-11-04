import type { Temporal } from '@mondapac/shared-kernel';
import { readyByOf, type SellerOrder } from './order';

/** One seller order marked ready in a window, with what its promise needs. */
export interface ReadyRecord {
  readonly readyAt: Temporal.Instant;
  readonly confirmedAt: Temporal.Instant;
  readonly deliveryMethod: SellerOrder['deliveryMethod'];
  readonly deliveryWindow: SellerOrder['deliveryWindow'];
  readonly readyPrepMinutes: number | null;
}

/**
 * The ready side of the seller health feed. Only seller orders that carry a promise count: an
 * order placed before the minutes were recorded has no ready-by time, so it is neither on time nor
 * late. An order is late when it was marked ready after its ready-by time (`readyByOf`); marked
 * ready at the ready-by moment is on time.
 */
export function readyAgainstPromise(records: readonly ReadyRecord[]): {
  readonly ready: number;
  readonly lateReady: number;
} {
  let ready = 0;
  let lateReady = 0;
  for (const record of records) {
    const by = readyByOf({ confirmedAt: record.confirmedAt }, record);
    if (by === null) continue;
    ready += 1;
    if (record.readyAt.epochNanoseconds > by.epochNanoseconds) lateReady += 1;
  }
  return { ready, lateReady };
}

/** A half-open window of instants: `from` included, `to` excluded. */
export interface HealthWindow {
  readonly from: Temporal.Instant;
  readonly to: Temporal.Instant;
}

/** The counters of one window for the seller health feed. */
export interface SellerOrderHealthCount {
  /** Seller orders whose order was paid in the window. */
  readonly paid: number;
  /** Seller orders marked ready in the window that carry a promise. */
  readonly ready: number;
  /** Of those, the ones marked ready after the ready-by time. */
  readonly lateReady: number;
}

const within = (at: Temporal.Instant, w: HealthWindow): boolean =>
  at.epochNanoseconds >= w.from.epochNanoseconds && at.epochNanoseconds < w.to.epochNanoseconds;

/**
 * Buckets what one read gave for the whole span into the windows asked for, in their order. A
 * paid time or a ready time outside every window is ignored.
 */
export function bucketSellerHealth(
  rows: {
    readonly paidAt: readonly Temporal.Instant[];
    readonly ready: readonly ReadyRecord[];
  },
  windows: readonly HealthWindow[],
): readonly SellerOrderHealthCount[] {
  return windows.map((w) => {
    const { ready, lateReady } = readyAgainstPromise(
      rows.ready.filter((r) => within(r.readyAt, w)),
    );
    return { paid: rows.paidAt.filter((at) => within(at, w)).length, ready, lateReady };
  });
}
