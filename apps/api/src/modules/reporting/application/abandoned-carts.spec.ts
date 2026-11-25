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
import type { AbandonedCartsDay } from '../domain/abandoned-carts';
import type { MarketDay } from '../domain/facts';
import type { DayRange } from '../domain/period';
import { FacadeAbandonedCartSources } from '../infrastructure/facade-abandoned-cart-sources';
import { RegistryMarketZone } from '../infrastructure/registry-market-zone';
import type { AbandonedCartCounts, AbandonedCartSources } from './ports/abandoned-cart-sources';
import type { AbandonedCartsStore } from './ports/abandoned-carts-store';
import { SnapshotAbandonedCarts } from './use-cases/snapshot-abandoned-carts.use-case';
import { ViewMarketplaceAbandonedCarts } from './use-cases/view-marketplace-abandoned-carts.use-case';

// Abandoned carts (dashboards v2, phase 2) on both Market fixtures, whose zones and currencies
// differ: the snapshot writes yesterday once, two hours after it ends in the Market's zone, from
// cart's carts untouched since 24 hours before that end, in the Market's currency; it never writes
// an older day, never rewrites one, and asks a day over cart's cap once per process; the read shows
// the period's latest day for a platform admin only.

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

class FakeStore implements AbandonedCartsStore {
  readonly rows = new Map<string, AbandonedCartsDay & { recordedAt: Temporal.Instant }>();

  hasDay(market: MarketContext, day: MarketDay) {
    return Promise.resolve(this.rows.has(`${market.marketId}|${day}`));
  }

  insertDay(market: MarketContext, day: AbandonedCartsDay, recordedAt: Temporal.Instant) {
    const key = `${market.marketId}|${day.day}`;
    if (this.rows.has(key)) return Promise.resolve(false);
    this.rows.set(key, { ...day, recordedAt });
    return Promise.resolve(true);
  }

  days(market: MarketContext, range: DayRange) {
    return Promise.resolve(
      [...this.rows.entries()]
        .filter(([key]) => key.startsWith(`${market.marketId}|`))
        .map(([, { day, carts, value }]) => ({ day, carts, value }))
        .filter((row) => row.day >= range.from && row.day <= range.to),
    );
  }
}

describe.each(TEST_MARKETS)('abandoned carts in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const zone = new RegistryMarketZone(markets);
  const tz = zone.zoneOf(market);
  const currency = zone.currencyOf(market);
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
  let counts: AbandonedCartCounts;
  let store: FakeStore;
  let clock: FixedClock;
  let asked: Temporal.Instant[];
  let sources: AbandonedCartSources;
  let snapshot: SnapshotAbandonedCarts;

  beforeEach(() => {
    counts = { carts: 12, values: [{ amount: 98_765n, currency }] };
    store = new FakeStore();
    // 01:30 on the Market's 25th: the 24th ended 90 minutes ago, so it is not due yet.
    clock = new FixedClock(startOf('2026-11-25').add({ minutes: 90 }));
    asked = [];
    sources = {
      abandonedCartsAt: (_context, at) => {
        asked.push(at);
        return Promise.resolve(ok(counts));
      },
    };
    snapshot = new SnapshotAbandonedCarts(gate, {
      unitOfWork,
      store,
      sources: { abandonedCartsAt: (context, at) => sources.abandonedCartsAt(context, at) },
      zone,
      clock,
    });
  });

  it('writes yesterday once, two hours after it ends, from carts idle 24 h at its end', async () => {
    const none = { written: 0, alreadyWritten: 0, failedDays: 0, cappedDays: 0 };
    expect(await snapshot.execute(system, {})).toEqual({ ok: true, value: none });
    expect(asked).toEqual([]);
    clock.set(startOf('2026-11-25').add({ hours: 2 }));
    expect(await snapshot.execute(system, {})).toEqual({
      ok: true,
      value: { ...none, written: 1 },
    });
    expect(asked).toEqual([startOf('2026-11-25').subtract({ hours: 24 })]);
    expect(store.rows.get(`${code}|2026-11-24`)).toEqual({
      day: '2026-11-24',
      carts: 12,
      value: { amount: 98_765n, currency },
      recordedAt: clock.now(),
    });
    // A second run has nothing left to ask.
    asked.length = 0;
    expect(await snapshot.execute(system, {})).toEqual({ ok: true, value: none });
    expect(asked).toEqual([]);
  });

  it('never writes an older day: a day missed is left without a row', async () => {
    clock.set(startOf('2026-11-27').add({ hours: 3 }));
    await snapshot.execute(system, {});
    expect([...store.rows.keys()]).toEqual([`${code}|2026-11-26`]);
  });

  it('keeps the row another run wrote first', async () => {
    clock.set(startOf('2026-11-25').add({ hours: 2 }));
    sources = {
      abandonedCartsAt: async () => {
        await store.insertDay(
          market,
          { day: '2026-11-24' as MarketDay, carts: 3, value: null },
          clock.now(),
        );
        return ok(counts);
      },
    };
    const out = await snapshot.execute(system, {});
    expect(out.ok && out.value.alreadyWritten).toBe(1);
    expect(store.rows.get(`${code}|2026-11-24`)).toMatchObject({ carts: 3 });
  });

  it('writes no value, only the count, when a line is in another currency', async () => {
    clock.set(startOf('2026-11-25').add({ hours: 2 }));
    counts = { carts: 9, values: [{ amount: 1n, currency: 'ZZZ' }] };
    const warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await snapshot.execute(system, {});
      expect(warnings).toHaveBeenCalledTimes(1);
    } finally {
      warnings.mockRestore();
    }
    expect(store.rows.get(`${code}|2026-11-24`)).toMatchObject({ carts: 9, value: null });
  });

  it('logs a failure by day and reason only, retries it, and asks a day over cap once', async () => {
    clock.set(startOf('2026-11-25').add({ hours: 2 }));
    let failure: { code: string; overCap?: boolean } = { code: 'cart:access.denied' };
    sources = {
      abandonedCartsAt: (_context, at) => {
        asked.push(at);
        return Promise.resolve(err(failure));
      },
    };
    const warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      expect(await snapshot.execute(system, {})).toMatchObject({ value: { failedDays: 1 } });
      expect(warnings.mock.calls.map(([entry]) => entry as unknown)).toEqual([
        {
          msg: 'reporting.abandoned-carts-snapshot.day-failed',
          day: '2026-11-24',
          reason: 'cart:access.denied',
          marketId: market.marketId,
          correlationId: system.correlationId,
        },
      ]);
      failure = { code: 'cart:cart.abandoned-too-large', overCap: true };
      expect(await snapshot.execute(system, {})).toMatchObject({ value: { failedDays: 1 } });
      asked.length = 0;
      expect(await snapshot.execute(system, {})).toEqual({
        ok: true,
        value: { written: 0, alreadyWritten: 0, failedDays: 0, cappedDays: 1 },
      });
      expect(asked).toEqual([]);
    } finally {
      warnings.mockRestore();
    }
    expect(store.rows.size).toBe(0);
  });

  it('runs for the system actor only', async () => {
    clock.set(startOf('2026-11-25').add({ hours: 2 }));
    expect(await snapshot.execute(person('admin'), {})).toMatchObject({ ok: false });
    expect(store.rows.size).toBe(0);
  });

  it('shows the latest day of the period for a platform admin only, and fails closed', async () => {
    const view = new ViewMarketplaceAbandonedCarts(gate, { unitOfWork, store, zone, clock });
    const today = Temporal.PlainDate.from(clock.now().toZonedDateTimeISO(tz).toPlainDate());
    for (let back = 1; back <= 14; back += 1) {
      await store.insertDay(
        market,
        {
          day: today.subtract({ days: back }).toString() as MarketDay,
          carts: 10 + back,
          value: { amount: BigInt(back) * 100n, currency },
        },
        clock.now(),
      );
    }
    const out = await view.execute(person('admin'), { period: '7d' });
    if (!out.ok) throw new Error('expected an answer');
    expect(out.value.abandonedCarts).toEqual({
      status: 'available',
      carts: 11,
      approximateValue: { amount: 100n, currency },
      asOfDay: today.subtract({ days: 1 }).toString(),
      // Against the latest day of the period before, the 7th day back (17 carts): -35.29 %.
      change: { value: -3529, direction: 'down', state: 'ok' },
      recordedDays: 6,
      periodDays: 7,
    });
    expect(await view.execute(person('seller'), { period: '7d' })).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    const failing = new ViewMarketplaceAbandonedCarts(gate, {
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

describe('the abandoned-cart sources adapter', () => {
  const market = testMarketContext('AU', PLATFORM_TENANT_ID);
  const system = testCallContext(market, 'system');
  const at = Temporal.Instant.from('2026-11-23T14:00:00Z');

  it('passes the instant to cart and answers the count and values only', async () => {
    const requests: unknown[] = [];
    const adapter = new FacadeAbandonedCartSources({
      abandonedCarts: (_context, request) => {
        requests.push(request);
        return Promise.resolve(ok({ carts: 4, values: [{ amount: 5n, currency: 'AUD' }] }));
      },
    });
    expect(await adapter.abandonedCartsAt(system, at)).toEqual({
      ok: true,
      value: { carts: 4, values: [{ amount: 5n, currency: 'AUD' }] },
    });
    expect(requests).toEqual([{ changedAtOrBefore: at }]);
  });

  it('marks cart’s line cap as over cap and passes any other refusal by its code', async () => {
    const tooLarge = new FacadeAbandonedCartSources({
      abandonedCarts: () => Promise.resolve(err({ code: 'cart.abandoned-too-large' as const })),
    });
    expect(await tooLarge.abandonedCartsAt(system, at)).toEqual({
      ok: false,
      error: { code: 'cart:cart.abandoned-too-large', overCap: true },
    });
    const denied = new FacadeAbandonedCartSources({
      abandonedCarts: () => Promise.resolve(err({ code: 'access.denied' as const })),
    });
    expect(await denied.abandonedCartsAt(system, at)).toEqual({
      ok: false,
      error: { code: 'cart:access.denied' },
    });
  });
});
