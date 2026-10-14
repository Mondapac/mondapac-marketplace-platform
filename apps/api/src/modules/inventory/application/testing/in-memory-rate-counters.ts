import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { RateReservation } from '../../domain/rate-limits';
import { windowRestartBefore } from '../../domain/rate-limits';
import type { RateCounter, RateCounterRepository } from '../ports/rate-counter.repository';

/**
 * An in-memory {@link RateCounterRepository} for the unit specs: fixed windows that restart when
 * they have ended, the same rule as the Prisma adapter. `failing` makes the store throw.
 */
export class InMemoryRateCounters implements RateCounterRepository {
  readonly rows = new Map<string, { count: number; windowStartedAt: Temporal.Instant }>();
  failing = false;

  reserve(
    market: MarketContext,
    counters: readonly RateCounter[],
    now: Temporal.Instant,
  ): Promise<readonly RateReservation[]> {
    if (this.failing) return Promise.reject(new Error('counter store down'));
    return Promise.resolve(
      counters.map((counter) => {
        const key = `${market.marketId}|${counter.limit.kind}|${Buffer.from(counter.keyHash).toString('hex')}`;
        let row = this.rows.get(key);
        if (
          row !== undefined &&
          Temporal.Instant.compare(row.windowStartedAt, windowRestartBefore(counter.limit, now)) <=
            0
        ) {
          row = undefined;
        }
        row = { count: (row?.count ?? 0) + 1, windowStartedAt: row?.windowStartedAt ?? now };
        this.rows.set(key, row);
        return { kind: counter.limit.kind, ...row };
      }),
    );
  }

  purgeStartedBefore(_market: MarketContext, startedBefore: Temporal.Instant): Promise<number> {
    let purged = 0;
    for (const [key, row] of this.rows) {
      if (Temporal.Instant.compare(row.windowStartedAt, startedBefore) < 0) {
        this.rows.delete(key);
        purged += 1;
      }
    }
    return Promise.resolve(purged);
  }
}
