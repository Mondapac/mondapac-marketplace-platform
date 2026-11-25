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
import { SNAPSHOT_LOOKBACK_DAYS } from '../domain/engagement';
import type { MarketDay } from '../domain/facts';
import type { DayRange } from '../domain/period';
import type { ZeroResultSearchDay } from '../domain/zero-result-searches';
import { FacadeSearchSources } from '../infrastructure/facade-search-sources';
import { RegistryMarketZone } from '../infrastructure/registry-market-zone';
import type { SearchSources, ZeroResultSearchCount } from './ports/search-sources';
import type { SearchStore } from './ports/search-store';
import { SnapshotDailySearches } from './use-cases/snapshot-daily-searches.use-case';
import { ViewMarketplaceZeroResultSearches } from './use-cases/view-marketplace-zero-result-searches.use-case';

// Zero-result searches (dashboards v2, phase 2) on both Market fixtures, whose zones are ahead of
// UTC: the snapshot writes each finished Market day once (a day with no qualifying text too), keeps
// only rows of at least ten searchers, never rewrites a day and keeps going past a day an owner
// could not count, logging no text; the read is for a platform admin only and fails closed; the
// adapter hands search's texts to engagement and passes no id either way.

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

class FakeStore implements SearchStore {
  readonly days = new Map<string, Temporal.Instant>();
  readonly queries: (ZeroResultSearchDay & { marketId: string })[] = [];

  recordedDays(market: MarketContext, range: DayRange) {
    return Promise.resolve(
      new Set(
        [...this.days.keys()]
          .filter((key) => key.startsWith(`${market.marketId}|`))
          .map((key) => key.split('|')[1] as MarketDay)
          .filter((day) => day >= range.from && day <= range.to),
      ),
    );
  }

  insertDay(
    market: MarketContext,
    day: MarketDay,
    rows: readonly Omit<ZeroResultSearchDay, 'day'>[],
    recordedAt: Temporal.Instant,
  ) {
    const key = `${market.marketId}|${day}`;
    if (this.days.has(key)) return Promise.resolve(false);
    this.days.set(key, recordedAt);
    for (const row of rows) this.queries.push({ ...row, day, marketId: market.marketId });
    return Promise.resolve(true);
  }

  rows(market: MarketContext, range: DayRange) {
    return Promise.resolve(
      this.queries
        .filter((row) => row.marketId === market.marketId)
        .filter((row) => row.day >= range.from && row.day <= range.to)
        .map(({ day, query, searchers, searches }) => ({ day, query, searchers, searches })),
    );
  }
}

describe.each(TEST_MARKETS)('zero-result searches in market %s', (code) => {
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
  const COUNTS: ZeroResultSearchCount[] = [
    { query: 'sangak bread', searchers: 12, searches: 20 },
    { query: 'nine people', searchers: 9, searches: 30 },
  ];
  let store: FakeStore;
  let clock: FixedClock;
  let windows: { from: Temporal.Instant; to: Temporal.Instant }[];
  let sources: SearchSources;
  let snapshot: SnapshotDailySearches;

  beforeEach(() => {
    store = new FakeStore();
    clock = new FixedClock(startOf('2026-11-25').add({ hours: 2 }));
    windows = [];
    sources = {
      zeroResultSearchesOf: (_context, window) => {
        windows.push(window);
        return Promise.resolve(ok(COUNTS));
      },
    };
    snapshot = new SnapshotDailySearches(gate, {
      unitOfWork,
      store,
      sources: {
        zeroResultSearchesOf: (context, window) => sources.zeroResultSearchesOf(context, window),
      },
      zone,
      clock,
    });
  });

  it('writes each finished Market day once, in the Market zone, keeping rows of ten or more only', async () => {
    expect(await snapshot.execute(system, {})).toEqual({
      ok: true,
      value: { written: SNAPSHOT_LOOKBACK_DAYS, alreadyWritten: 0, failedDays: 0, cappedDays: 0 },
    });
    expect(windows.at(-1)).toEqual({ from: startOf('2026-11-24'), to: startOf('2026-11-25') });
    expect(store.queries.filter((row) => row.day === '2026-11-24')).toEqual([
      {
        day: '2026-11-24',
        query: 'sangak bread',
        searchers: 12,
        searches: 20,
        marketId: code,
      },
    ]);
    expect(store.queries.some((row) => row.query === 'nine people')).toBe(false);
    windows.length = 0;
    expect((await snapshot.execute(system, {})).ok).toBe(true);
    expect(windows).toEqual([]);
  });

  it('records a day with no qualifying text, so it is not asked again', async () => {
    sources = { zeroResultSearchesOf: () => Promise.resolve(ok([])) };
    await snapshot.execute(system, {});
    expect(store.days.size).toBe(SNAPSHOT_LOOKBACK_DAYS);
    expect(store.queries).toEqual([]);
  });

  it('skips a day an owner could not count, logs its day and reason only (never a text)', async () => {
    sources = {
      zeroResultSearchesOf: (_context, window) =>
        Promise.resolve(
          window.from.equals(startOf('2026-11-20'))
            ? err({ code: 'engagement:engagement.search-too-large', overCap: true })
            : ok(COUNTS),
        ),
    };
    const warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const out = await snapshot.execute(system, {});
      expect(out).toEqual({
        ok: true,
        value: {
          written: SNAPSHOT_LOOKBACK_DAYS - 1,
          alreadyWritten: 0,
          failedDays: 1,
          cappedDays: 0,
        },
      });
      expect(warnings.mock.calls.map(([entry]) => entry as unknown)).toEqual([
        {
          msg: 'reporting.search-snapshot.day-failed',
          day: '2026-11-20',
          reason: 'engagement:engagement.search-too-large',
          marketId: market.marketId,
          correlationId: system.correlationId,
        },
      ]);
      const second = await snapshot.execute(system, {});
      expect(second.ok && second.value).toMatchObject({ failedDays: 0, cappedDays: 1 });
    } finally {
      warnings.mockRestore();
    }
  });

  it('runs for the system actor only', async () => {
    expect(await snapshot.execute(person('admin'), {})).toMatchObject({ ok: false });
    expect(store.days.size).toBe(0);
  });

  it('reads the period for a platform admin only, and fails closed', async () => {
    const view = new ViewMarketplaceZeroResultSearches(gate, { unitOfWork, store, zone, clock });
    await snapshot.execute(system, {});
    const out = await view.execute(person('admin'), { period: '7d' });
    if (!out.ok) throw new Error('expected an answer');
    expect(out.value.searches).toEqual({
      status: 'available',
      queries: [{ query: 'sangak bread', searches: 6 * 20, searcherDays: 6 * 12, days: 6 }],
      recordedDays: 6,
      periodDays: 7,
    });
    expect(await view.execute(person('seller'), { period: '7d' })).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    const failing = new ViewMarketplaceZeroResultSearches(gate, {
      unitOfWork,
      store: {
        recordedDays: (m: MarketContext, r: DayRange) => store.recordedDays(m, r),
        insertDay: () => Promise.resolve(false),
        rows: () => Promise.reject(new TypeError('down')),
      },
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

describe('the zero-result sources adapter', () => {
  const market = testMarketContext('AU', PLATFORM_TENANT_ID);
  const system = testCallContext(market, 'system');
  const window = {
    from: Temporal.Instant.from('2026-11-23T14:00:00Z'),
    to: Temporal.Instant.from('2026-11-24T14:00:00Z'),
  };

  it('hands search’s texts to engagement and answers texts with counts only', async () => {
    const asked: unknown[] = [];
    const adapter = new FacadeSearchSources(
      { zeroResultTexts: () => Promise.resolve(ok({ texts: ['barberry', 'sumac'] })) },
      {
        searchShoppers: (_context, request) => {
          asked.push(request);
          return Promise.resolve(ok([{ query: 'barberry', shoppers: 11, searches: 14 }]));
        },
      },
    );
    expect(await adapter.zeroResultSearchesOf(system, window)).toEqual({
      ok: true,
      value: [{ query: 'barberry', searchers: 11, searches: 14 }],
    });
    expect(asked).toEqual([{ window, queries: ['barberry', 'sumac'] }]);
  });

  it('asks engagement nothing when search has no text, and passes a refusal on by its code', async () => {
    const engagement = {
      searchShoppers: jest.fn(() =>
        Promise.resolve(err({ code: 'engagement.search-too-large' as const })),
      ),
    };
    const none = new FacadeSearchSources(
      { zeroResultTexts: () => Promise.resolve(ok({ texts: [] })) },
      engagement,
    );
    expect(await none.zeroResultSearchesOf(system, window)).toEqual({ ok: true, value: [] });
    expect(engagement.searchShoppers).not.toHaveBeenCalled();
    const tooLarge = new FacadeSearchSources(
      { zeroResultTexts: () => Promise.resolve(ok({ texts: ['barberry'] })) },
      engagement,
    );
    expect(await tooLarge.zeroResultSearchesOf(system, window)).toEqual({
      ok: false,
      error: { code: 'engagement:engagement.search-too-large', overCap: true },
    });
    const refused = new FacadeSearchSources(
      {
        zeroResultTexts: () => Promise.resolve(err({ code: 'validation.failed' as const })),
      },
      engagement,
    );
    expect(await refused.zeroResultSearchesOf(system, window)).toEqual({
      ok: false,
      error: { code: 'search:validation.failed' },
    });
  });
});
