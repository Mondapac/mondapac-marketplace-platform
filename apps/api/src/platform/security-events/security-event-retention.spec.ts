import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext, Result } from '@mondapac/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { UnitOfWork } from '../unit-of-work/unit-of-work';
import {
  RETENTION_BATCH,
  RETENTION_MAX_BATCHES,
  SecurityEventRetention,
  type SecurityEventStore,
} from './security-event-retention';

const NOW = Temporal.Instant.from('2026-10-25T12:00:00Z');

/** Runs each unit at once and counts them. */
class CountingUnitOfWork {
  units = 0;
  run<T, E>(_market: MarketContext, work: () => Promise<Result<T, E>>): Promise<Result<T, E>> {
    this.units += 1;
    return work();
  }
}

/** A store holding a number of rows to archive and to purge, answering in batches. */
class CountingStore implements SecurityEventStore {
  calls: { kind: 'archive' | 'purge'; before: Temporal.Instant }[] = [];
  constructor(
    private hot: number,
    private archived: number,
  ) {}

  archive(_market: MarketContext, before: Temporal.Instant, _at: Temporal.Instant, limit: number) {
    this.calls.push({ kind: 'archive', before });
    const moved = Math.min(limit, this.hot);
    this.hot -= moved;
    return Promise.resolve(moved);
  }

  purgeArchive(_market: MarketContext, before: Temporal.Instant, limit: number) {
    this.calls.push({ kind: 'purge', before });
    const purged = Math.min(limit, this.archived);
    this.archived -= purged;
    return Promise.resolve(purged);
  }
}

describe('SecurityEventRetention (SOC decision T6)', () => {
  const market = testMarketContext('AU', 'default');

  it('archives at 90 days and purges the archive at 90 + 365 days, one unit a batch', async () => {
    const units = new CountingUnitOfWork();
    const store = new CountingStore(RETENTION_BATCH + 3, 2);
    const retention = new SecurityEventRetention(
      units as unknown as UnitOfWork,
      store,
      new FixedClock(NOW),
    );

    await expect(retention.run(market)).resolves.toEqual({
      archived: RETENTION_BATCH + 3,
      purged: 2,
      backlog: false,
    });
    expect(store.calls).toEqual([
      { kind: 'archive', before: NOW.subtract({ hours: 90 * 24 }) },
      { kind: 'archive', before: NOW.subtract({ hours: 90 * 24 }) },
      { kind: 'purge', before: NOW.subtract({ hours: 455 * 24 }) },
    ]);
    expect(units.units).toBe(3);
  });

  it('stops after its batch budget per table; the next tick goes on', async () => {
    const units = new CountingUnitOfWork();
    const store = new CountingStore(RETENTION_BATCH * (RETENTION_MAX_BATCHES + 2), 0);
    const retention = new SecurityEventRetention(
      units as unknown as UnitOfWork,
      store,
      new FixedClock(NOW),
    );

    const report = await retention.run(market);
    expect(report.archived).toBe(RETENTION_BATCH * RETENTION_MAX_BATCHES);
    expect(units.units).toBe(RETENTION_MAX_BATCHES + 1);
  });
});
