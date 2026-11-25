import { Logger } from '@nestjs/common';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import type { EngagementFacade } from '../../engagement';
import { SNAPSHOT_LOOKBACK_DAYS, type EngagementDay } from '../domain/engagement';
import type { MarketDay } from '../domain/facts';
import type { DayRange } from '../domain/period';
import { FacadeEngagementSources } from '../infrastructure/facade-engagement-sources';
import { RegistryMarketZone } from '../infrastructure/registry-market-zone';
import type { EngagementSources, FunnelCounts } from './ports/engagement-sources';
import type { EngagementStore } from './ports/engagement-store';
import { SnapshotDailyEngagement } from './use-cases/snapshot-daily-engagement.use-case';
import { ViewMarketplaceShoppingFunnel } from './use-cases/view-marketplace-shopping-funnel.use-case';

// The shopping funnel (dashboards v2, phase 2) on both Market fixtures, whose zones are ahead of
// UTC: the snapshot writes each finished Market day once, two hours after it ends in the Market's
// zone, never rewrites it, and keeps going past a day an owner could not count; the read sums the
// Market days of the period for a platform admin only; the adapter hands ordering's checkouts to
// engagement unchanged and refuses an incomplete list.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const gate = createUseCaseGate(markets, {
  check: () => Promise.resolve({ allowed: true as const }),
});
const unitOfWork = {
  run: (_market: unknown, work: () => Promise<unknown>) => work(),
} as never;

class FakeStore implements EngagementStore {
  readonly rows = new Map<string, EngagementDay & { recordedAt: Temporal.Instant }>();
  readonly ranges: DayRange[] = [];

  recordedDays(market: MarketContext, range: DayRange) {
    this.ranges.push(range);
    return Promise.resolve(
      new Set(
        [...this.rows.keys()]
          .filter((key) => key.startsWith(`${market.marketId}|`))
          .map((key) => key.split('|')[1] as MarketDay)
          .filter((day) => day >= range.from && day <= range.to),
      ),
    );
  }

  insertDay(market: MarketContext, day: EngagementDay, recordedAt: Temporal.Instant) {
    const key = `${market.marketId}|${day.day}`;
    if (this.rows.has(key)) return Promise.resolve(false);
    this.rows.set(key, { ...day, recordedAt });
    return Promise.resolve(true);
  }

  days(market: MarketContext, range: DayRange) {
    return Promise.resolve(
      [...this.rows.entries()]
        .filter(([key]) => key.startsWith(`${market.marketId}|`))
        .map(([, row]) => row)
        .filter((row) => row.day >= range.from && row.day <= range.to)
        .map(({ day, viewed, carted, checkedOut, paid }) => ({
          day,
          viewed,
          carted,
          checkedOut,
          paid,
        })),
    );
  }
}

describe.each(TEST_MARKETS)('the shopping funnel in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const zone = new RegistryMarketZone(markets);
  const tz = zone.zoneOf(market);
  const system = testCallContext(market, 'system');
  const person = (population: 'admin' | 'seller'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: id(population === 'admin' ? 0xa1 : 0xb1),
        sessionId: id(0x10a1),
        sellerId: population === 'seller' ? id(0x5e11) : null,
      }),
    );
  const startOf = (text: string) =>
    Temporal.PlainDate.from(text).toZonedDateTime({ timeZone: tz }).toInstant();
  const COUNTS: FunnelCounts = { viewed: 40, carted: 12, checkedOut: 6, paid: 5 };
  let store: FakeStore;
  let clock: FixedClock;
  let windows: { from: Temporal.Instant; to: Temporal.Instant }[];
  let sources: EngagementSources;
  let snapshot: SnapshotDailyEngagement;

  beforeEach(() => {
    store = new FakeStore();
    // 01:30 on the Market's 25th: the 24th ended 90 minutes ago, so it is not due yet.
    clock = new FixedClock(startOf('2026-11-25').add({ minutes: 90 }));
    windows = [];
    sources = {
      funnelOf: (_context, window) => {
        windows.push(window);
        return Promise.resolve(ok(COUNTS));
      },
    };
    snapshot = new SnapshotDailyEngagement(gate, {
      unitOfWork,
      store,
      sources: { funnelOf: (context, window) => sources.funnelOf(context, window) },
      zone,
      clock,
    });
  });

  it('writes each finished Market day of the look-back once, in the Market zone', async () => {
    expect(await snapshot.execute(system, {})).toEqual({
      ok: true,
      value: { written: SNAPSHOT_LOOKBACK_DAYS - 1, alreadyWritten: 0, failedDays: 0 },
    });
    expect(windows.at(-1)).toEqual({ from: startOf('2026-11-23'), to: startOf('2026-11-24') });
    expect(store.ranges[0]).toEqual({ from: '2026-10-28', to: '2026-11-24' });
    clock.set(startOf('2026-11-25').add({ hours: 2 }));
    windows.length = 0;
    expect(await snapshot.execute(system, {})).toEqual({
      ok: true,
      value: { written: 1, alreadyWritten: 0, failedDays: 0 },
    });
    expect(windows).toEqual([{ from: startOf('2026-11-24'), to: startOf('2026-11-25') }]);
    expect(store.rows.get(`${code}|2026-11-24`)).toMatchObject({ ...COUNTS, day: '2026-11-24' });
    // A second run has nothing left to ask.
    windows.length = 0;
    expect((await snapshot.execute(system, {})).ok).toBe(true);
    expect(windows).toEqual([]);
  });

  it('never rewrites a day another run wrote first', async () => {
    const first = { day: '2026-11-23' as MarketDay, viewed: 9, carted: 1, checkedOut: 0, paid: 0 };
    sources = {
      funnelOf: async (_context, window) => {
        // Another run writes the 23rd while this one is reading it.
        if (window.from.equals(startOf('2026-11-23'))) {
          await store.insertDay(market, first, clock.now());
        }
        return ok(COUNTS);
      },
    };
    const out = await snapshot.execute(system, {});
    expect(out.ok && out.value.alreadyWritten).toBe(1);
    expect(store.rows.get(`${code}|2026-11-23`)).toMatchObject({ viewed: 9 });
  });

  it('skips a day an owner could not count, logs its day and reason only, and writes the rest', async () => {
    sources = {
      funnelOf: (_context, window) =>
        Promise.resolve(
          window.from.equals(startOf('2026-11-20'))
            ? err({ code: 'ordering:too-many-checkouts' })
            : ok(COUNTS),
        ),
    };
    const warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const out = await snapshot.execute(system, {});
      expect(out).toEqual({
        ok: true,
        value: { written: SNAPSHOT_LOOKBACK_DAYS - 2, alreadyWritten: 0, failedDays: 1 },
      });
      expect(warnings.mock.calls.map(([entry]) => entry as unknown)).toEqual([
        {
          msg: 'reporting.engagement-snapshot.day-failed',
          day: '2026-11-20',
          reason: 'ordering:too-many-checkouts',
          marketId: market.marketId,
          correlationId: system.correlationId,
        },
      ]);
    } finally {
      warnings.mockRestore();
    }
    expect(store.rows.has(`${code}|2026-11-20`)).toBe(false);
  });

  it('runs for the system actor only', async () => {
    expect(await snapshot.execute(person('admin'), {})).toMatchObject({ ok: false });
    expect(store.rows.size).toBe(0);
  });

  it('reads the period and the one before for a platform admin only, and fails closed', async () => {
    const view = new ViewMarketplaceShoppingFunnel(gate, { unitOfWork, store, zone, clock });
    const today = Temporal.PlainDate.from(clock.now().toZonedDateTimeISO(tz).toPlainDate());
    for (let back = 1; back <= 14; back += 1) {
      await store.insertDay(
        market,
        { day: today.subtract({ days: back }).toString() as MarketDay, ...COUNTS },
        clock.now(),
      );
    }
    const out = await view.execute(person('admin'), { period: '7d' });
    if (!out.ok) throw new Error('expected an answer');
    expect(out.value.period.current.to).toBe(today.toString());
    expect(out.value.funnel).toMatchObject({
      status: 'available',
      viewed: { count: 6 * 40, change: { state: 'ok', value: -1428 } },
      paid: { count: 6 * 5, rateBp: 8333 },
      recordedDays: 6,
      periodDays: 7,
    });
    expect(await view.execute(person('seller'), { period: '7d' })).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    const failing = new ViewMarketplaceShoppingFunnel(gate, {
      unitOfWork,
      store: { ...store, days: () => Promise.reject(new TypeError('down')) } as never,
      zone,
      clock,
    });
    const warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      expect(await failing.execute(person('admin'), { period: '7d' })).toEqual({
        ok: false,
        error: { code: 'access.unavailable' },
      });
    } finally {
      warnings.mockRestore();
    }
  });
});

describe('the funnel sources adapter', () => {
  const market = testMarketContext('AU', PLATFORM_TENANT_ID);
  const system = testCallContext(market, 'system');
  const window = {
    from: Temporal.Instant.from('2026-11-23T14:00:00Z'),
    to: Temporal.Instant.from('2026-11-24T14:00:00Z'),
  };
  const items = [{ accountId: id<'Account'>(0xa1), paid: true }];

  it('hands ordering’s checkouts to engagement unchanged and answers the counts only', async () => {
    const asked: unknown[] = [];
    const adapter = new FacadeEngagementSources(
      { checkoutsStarted: () => Promise.resolve(ok({ items, complete: true })) },
      {
        shoppingFunnel: (_context, request) => {
          asked.push(request);
          return Promise.resolve(ok({ viewed: 3, carted: 2, checkedOut: 1, paid: 1 }));
        },
      },
    );
    expect(await adapter.funnelOf(system, window)).toEqual({
      ok: true,
      value: { viewed: 3, carted: 2, checkedOut: 1, paid: 1 },
    });
    expect(asked).toEqual([{ window, checkouts: items }]);
  });

  it('refuses an incomplete checkout list and passes an owner’s refusal on by its code', async () => {
    const engagement = {
      shoppingFunnel: () => Promise.resolve(err({ code: 'engagement.funnel-too-large' as const })),
    } as Pick<EngagementFacade, 'shoppingFunnel'>;
    const incomplete = new FacadeEngagementSources(
      { checkoutsStarted: () => Promise.resolve(ok({ items, complete: false })) },
      engagement,
    );
    expect(await incomplete.funnelOf(system, window)).toEqual({
      ok: false,
      error: { code: 'ordering:too-many-checkouts' },
    });
    const tooLarge = new FacadeEngagementSources(
      { checkoutsStarted: () => Promise.resolve(ok({ items, complete: true })) },
      engagement,
    );
    expect(await tooLarge.funnelOf(system, window)).toEqual({
      ok: false,
      error: { code: 'engagement:engagement.funnel-too-large' },
    });
  });
});
