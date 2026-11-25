import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { ZeroResultLog } from '../ports/zero-result-log';

/** An in-memory {@link ZeroResultLog} for unit tests; `failing` makes every note throw. */
export class MemoryZeroResultLog implements ZeroResultLog {
  rows: { marketId: string; key: string; bucketStart: Temporal.Instant }[] = [];
  failing = false;
  /** Calls of `note` (the recent-notes cache skips repeats) and of `purgeBefore`. */
  noteCalls = 0;
  purgeCalls = 0;

  note(market: MarketContext, key: string, bucketStart: Temporal.Instant) {
    this.noteCalls += 1;
    if (this.failing) return Promise.reject(new Error('down'));
    const seen = this.rows.some(
      (row) =>
        row.marketId === market.marketId && row.key === key && row.bucketStart.equals(bucketStart),
    );
    if (!seen) this.rows.push({ marketId: market.marketId, key, bucketStart });
    return Promise.resolve();
  }

  textsIn(
    market: MarketContext,
    window: { readonly from: Temporal.Instant; readonly to: Temporal.Instant },
    limit: number,
  ) {
    const counts = new Map<string, number>();
    for (const row of this.rows) {
      const at = row.bucketStart.epochMilliseconds;
      if (
        row.marketId === market.marketId &&
        at >= window.from.epochMilliseconds &&
        at < window.to.epochMilliseconds
      ) {
        counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
      }
    }
    return Promise.resolve(
      [...counts]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, limit)
        .map(([key]) => key),
    );
  }

  purgeBefore(market: MarketContext, before: Temporal.Instant, limit: number) {
    const old = this.rows
      .filter(
        (row) =>
          row.marketId === market.marketId &&
          row.bucketStart.epochMilliseconds < before.epochMilliseconds,
      )
      .sort((a, b) => a.bucketStart.epochMilliseconds - b.bucketStart.epochMilliseconds)
      .slice(0, limit);
    this.rows = this.rows.filter((row) => !old.includes(row));
    this.purgeCalls += 1;
    return Promise.resolve(old.length);
  }
}
