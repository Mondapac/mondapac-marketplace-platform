import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { noRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { DefaultSellerHealthPolicy } from '../../infrastructure/default-seller-health-policy';
import type { SellerHealthDay } from '../../domain/seller-health-days';
import type { SellerHealthRoster, SellerHealthRosterEntry } from '../ports/seller-health-roster';
import type { SellerHealthSignals } from '../ports/seller-health-signals';
import type { SellerHealthSnapshot, SellerHealthStore } from '../ports/seller-health.store';
import {
  RunSellerHealth,
  SELLER_HEALTH_BATCH,
  SELLER_HEALTH_PAUSE_MS,
} from './run-seller-health.use-case';

// `sellers.run-seller-health` in memory, on both Market fixtures. The store and the feeds are
// covered against PostgreSQL by test/db/sellers-health-store.db-spec.ts and the feeds' own specs.

// 2026-11-10 23:30 UTC: it is already 2026-11-11 in Brisbane (+10) and still 2026-11-10 in UTC.
const NOW = Temporal.Instant.from('2026-11-10T23:30:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, null);

const sellerId = (n: number) =>
  `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}` as Id<'Seller'>;

class MemoryStore {
  readonly dayRows = new Map<string, SellerHealthDay>();
  readonly snaps = new Map<string, SellerHealthSnapshot>();

  readonly store: SellerHealthStore = {
    saveDay: (market, seller, day) => {
      this.dayRows.set(`${market.marketId}|${seller}|${day.day.toString()}`, day);
      return Promise.resolve();
    },
    days: (market, seller, from, to) =>
      Promise.resolve(
        [...this.dayRows.entries()]
          .filter(
            ([key, day]) =>
              key.startsWith(`${market.marketId}|${seller}|`) &&
              Temporal.PlainDate.compare(day.day, from) >= 0 &&
              Temporal.PlainDate.compare(day.day, to) <= 0,
          )
          .map(([, day]) => day),
      ),
    saveSnapshot: (market, seller, snapshot) => {
      this.snaps.set(`${market.marketId}|${seller}|${snapshot.day.toString()}`, snapshot);
      return Promise.resolve();
    },
    purgeBefore: () => Promise.resolve({ days: 0, snapshots: 0 }),
    snapshots: (market, seller, from, to) =>
      Promise.resolve(
        [...this.snaps.entries()]
          .filter(
            ([key, snap]) =>
              key.startsWith(`${market.marketId}|${seller}|`) &&
              Temporal.PlainDate.compare(snap.day, from) >= 0 &&
              Temporal.PlainDate.compare(snap.day, to) <= 0,
          )
          .map(([, snap]) => snap),
      ),
    latest: () => Promise.resolve(new Map()),
  };
}

function setUp(entries: readonly SellerHealthRosterEntry[], options: { unitFails?: boolean } = {}) {
  const memory = new MemoryStore();
  const store = memory.store;
  const units: { readOnly: boolean }[] = [];
  const unitOfWork: UnitOfWork = {
    run: <T, E>(_market: MarketContext, work: () => Promise<Result<T, E>>, opts?: unknown) => {
      units.push({ readOnly: (opts as { readOnly?: boolean } | undefined)?.readOnly === true });
      return options.unitFails ? Promise.reject(new Error('db down')) : work();
    },
    runOnce: noRunOnce,
  };
  const roster: SellerHealthRoster = {
    page: (_m, after, limit) =>
      Promise.resolve(
        entries.filter((entry) => after === null || entry.sellerId > after).slice(0, limit),
      ),
  };
  const asked: { seller: Id<'Seller'>; days: string[]; zone: string }[] = [];
  const failing = new Set<Id<'Seller'>>();
  const signals: SellerHealthSignals = {
    days: (_c, seller, days, zone) => {
      asked.push({ seller, days: days.map(String), zone });
      if (failing.has(seller)) return Promise.reject(new Error('feed down'));
      return Promise.resolve(
        days.map((day) => ({
          day,
          paidOrders: 12,
          readyOrders: 12,
          lateReadyOrders: 0,
          lostDisputes: 0,
          reviewsApproved: 0,
          ratingStarsSum: 0,
        })),
      );
    },
  };
  const clock = new FixedClock(NOW);
  const run = new RunSellerHealth(gate, {
    unitOfWork,
    healthRoster: roster,
    healthStore: store,
    healthSignals: signals,
    healthPolicy: new DefaultSellerHealthPolicy(),
    clock,
  });
  return {
    memory,
    units,
    asked,
    failing,
    run,
    ids: new SequenceIdGenerator(clock),
  };
}

describe.each(['AU', 'ZZ'] as const)('sellers.run-seller-health (%s)', (code) => {
  const market = testMarketContext(code, 'default');
  const context = testCallContext(market, 'system');
  const BRISBANE = 'Australia/Brisbane';

  it('cuts each seller`s day in its own zone and recounts the last three local days', async () => {
    const t = setUp([
      { sellerId: sellerId(1), zone: BRISBANE },
      { sellerId: sellerId(2), zone: 'UTC' },
    ]);
    const result = await t.run.execute(context, {});
    expect(result).toEqual({ ok: true, value: { measured: 2, skipped: 0, failed: 0 } });
    expect(t.asked).toEqual([
      { seller: sellerId(1), days: ['2026-11-09', '2026-11-10', '2026-11-11'], zone: BRISBANE },
      { seller: sellerId(2), days: ['2026-11-08', '2026-11-09', '2026-11-10'], zone: 'UTC' },
    ]);
    expect(t.memory.snaps.has(`${code}|${sellerId(1)}|2026-11-11`)).toBe(true);
    expect(t.memory.snaps.has(`${code}|${sellerId(2)}|2026-11-10`)).toBe(true);
    expect(t.memory.dayRows.size).toBe(6);
  });

  it('skips a seller already measured for its local date, so a repeat reads nothing', async () => {
    const t = setUp([{ sellerId: sellerId(1), zone: BRISBANE }]);
    await t.run.execute(context, {});
    t.asked.length = 0;
    const again = await t.run.execute(context, {});
    expect(again).toEqual({ ok: true, value: { measured: 0, skipped: 1, failed: 0 } });
    expect(t.asked).toEqual([]);
  });

  it('isolates a failing seller: it is reported and counted, the others are measured', async () => {
    const t = setUp([
      { sellerId: sellerId(1), zone: 'UTC' },
      { sellerId: sellerId(2), zone: 'UTC' },
      { sellerId: sellerId(3), zone: 'UTC' },
    ]);
    t.failing.add(sellerId(2));
    const failures: Id<'Seller'>[] = [];
    const result = await t.run.execute(context, { onFailure: (seller) => failures.push(seller) });
    expect(result).toEqual({ ok: true, value: { measured: 2, skipped: 0, failed: 1 } });
    expect(failures).toEqual([sellerId(2)]);
    expect(t.memory.snaps.has(`${code}|${sellerId(2)}|2026-11-10`)).toBe(false);
    expect(t.memory.dayRows.size).toBe(6);
  });

  it('walks the roster in batches with a pause between them', async () => {
    const entries = Array.from({ length: SELLER_HEALTH_BATCH + 3 }, (_, i) => ({
      sellerId: sellerId(i + 1),
      zone: 'UTC',
    }));
    const t = setUp(entries);
    const pauses: number[] = [];
    const result = await t.run.execute(context, {
      pause: (ms) => {
        pauses.push(ms);
        return Promise.resolve();
      },
    });
    expect(result).toEqual({
      ok: true,
      value: { measured: SELLER_HEALTH_BATCH + 3, skipped: 0, failed: 0 },
    });
    expect(pauses).toEqual([SELLER_HEALTH_PAUSE_MS]);
  });

  it('counts a seller whose unit throws as failed and stores nothing', async () => {
    const t = setUp([{ sellerId: sellerId(1), zone: 'UTC' }], { unitFails: true });
    // The roster read itself is a unit: its failure ends the run for this Market.
    await expect(t.run.execute(context, {})).rejects.toThrow('db down');
    expect(t.memory.snaps.size).toBe(0);
  });

  it('refuses a request actor at the gate and measures nothing', async () => {
    const t = setUp([{ sellerId: sellerId(1), zone: 'UTC' }]);
    const seller = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: t.ids.next<'Account'>(),
        sessionId: t.ids.next<'Session'>(),
        sellerId: t.ids.next<'Seller'>(),
      }),
    );
    for (const refused of [seller, testCallContext(market, 'anonymous')]) {
      expect((await t.run.execute(refused, {})).ok).toBe(false);
    }
    expect(t.asked).toEqual([]);
    expect(t.memory.snaps.size).toBe(0);
  });
});
