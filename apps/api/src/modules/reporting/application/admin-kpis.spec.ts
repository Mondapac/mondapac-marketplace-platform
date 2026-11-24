import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
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
import { emptyDay, type DayTotals } from '../domain/admin-kpi';
import type { OrderStatusTallies } from '../domain/admin-health';
import type { MarketDay } from '../domain/facts';
import { EMPTY_LEDGER_SUMS, type LedgerKindSums } from '../domain/ledger';
import { windowOf, type DayRange } from '../domain/period';
import { RegistryMarketZone } from '../infrastructure/registry-market-zone';
import type { AdminKpiDependencies } from './admin-kpi-flow';
import type {
  AdminKpiReader,
  CategoryTotals,
  DailyTotals,
  SellerTotals,
} from './ports/admin-kpi-reader';
import type { LedgerKpiReader, LedgerMatchFacts } from './ports/ledger-kpi-reader';
import {
  ViewMarketplaceFinanceKpis,
  type FinanceKpiDependencies,
} from './use-cases/view-marketplace-finance-kpis.use-case';
import { ViewMarketplaceOrderStatus } from './use-cases/view-marketplace-order-status.use-case';
import { ViewMarketplaceOperationsKpis } from './use-cases/view-marketplace-operations-kpis.use-case';
import { ViewMarketplaceTopCategories } from './use-cases/view-marketplace-top-categories.use-case';
import { ViewMarketplaceTopSellers } from './use-cases/view-marketplace-top-sellers.use-case';

// The admin KPI reads (dashboards upgrade phase 5) on both Market fixtures: today is the MARKET's
// day, the previous period is read next to the current one, money is in the Market's currency
// only, and only a platform admin acting as themselves is answered.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const gate = createUseCaseGate(markets, {
  check: () => Promise.resolve({ allowed: true as const }),
});
// 2026-11-22 14:30 UTC: already the 23rd in Brisbane (+10), still the 22nd in a UTC-8 Market.
const NOW = Temporal.Instant.from('2026-11-22T14:30:00Z');

class FakeReader implements AdminKpiReader {
  readonly calls: { currency: string; range: DayRange; marketId: string }[] = [];
  rows: DayTotals[] = [];
  refreshedAt: Temporal.Instant | null = null;
  sellers: SellerTotals[] = [];
  categories: CategoryTotals[] = [];
  sellerCount = 0;
  sellerCountCalls = 0;
  tallies: OrderStatusTallies = {
    paid: 0,
    cancelled: 0,
    delivered: 0,
    shipped: 0,
    refunded: { delivered: 0, shipped: 0, toShip: 0 },
  };
  readonly tallyCalls: { currency: string; range: DayRange; marketId: string }[] = [];

  orderStatusTallies(
    market: { marketId: string },
    currency: string,
    range: DayRange,
  ): Promise<OrderStatusTallies> {
    this.tallyCalls.push({ currency, range, marketId: market.marketId });
    return Promise.resolve(this.tallies);
  }

  sellersWithOrders(): Promise<number> {
    this.sellerCountCalls += 1;
    return Promise.resolve(this.sellerCount);
  }
  readonly categoryCalls: { currency: string; range: DayRange; limit: number }[] = [];

  topCategories(
    _market: { marketId: string },
    currency: string,
    range: DayRange,
    limit: number,
  ): Promise<CategoryTotals[]> {
    this.categoryCalls.push({ currency, range, limit });
    return Promise.resolve(this.categories.slice(0, limit));
  }
  readonly topCalls: { currency: string; range: DayRange; limit: number }[] = [];

  topSellers(
    _market: { marketId: string },
    currency: string,
    range: DayRange,
    limit: number,
  ): Promise<SellerTotals[]> {
    this.topCalls.push({ currency, range, limit });
    return Promise.resolve(this.sellers.slice(0, limit));
  }

  dailyTotals(
    market: { marketId: string },
    currency: string,
    range: DayRange,
  ): Promise<DailyTotals> {
    this.calls.push({ currency, range, marketId: market.marketId });
    const days = this.rows.filter((row) => row.day >= range.from && row.day <= range.to);
    return Promise.resolve({ days, refreshedAt: this.refreshedAt });
  }
}

/** The ledger reads of the finance answer's net figures (dashboards v2 PR 6). */
class FakeLedger implements LedgerKpiReader {
  readonly ranges: DayRange[] = [];
  finished = true;
  failing = false;
  match: LedgerMatchFacts = { paid: [], commission: [], knownUnpaid: new Set() };
  sums: (range: DayRange) => LedgerKindSums = () => EMPTY_LEDGER_SUMS;

  rangeSums(_market: unknown, _currency: string, range: DayRange) {
    this.ranges.push(range);
    if (this.failing) return Promise.reject(new TypeError('down'));
    return Promise.resolve({ sums: this.sums(range), refreshedAt: null });
  }
  matchFacts() {
    return Promise.resolve(this.match);
  }
  backfillState() {
    return Promise.resolve({ finished: this.finished, failedFacts: 0 });
  }
}

/** A week with one matched seller order a day ending yesterday: the readiness minimum. */
const busyWeek = (today: string): LedgerMatchFacts => {
  const rows = Array.from({ length: 7 }, (_, n) => ({
    sellerOrderId: `so-${n}`,
    day: Temporal.PlainDate.from(today)
      .subtract({ days: n + 1 })
      .toString() as MarketDay,
  }));
  return { paid: rows, commission: rows, knownUnpaid: new Set() };
};

const commissionSums = (charged: bigint, refunded: bigint): LedgerKindSums => ({
  ...EMPTY_LEDGER_SUMS,
  commission: { amount: charged, baseAmount: 0n },
  'refund-commission': { amount: refunded, baseAmount: 0n },
});

describe.each(TEST_MARKETS)('the admin KPIs in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const zone = new RegistryMarketZone(markets);
  const admin = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: id(0xa1),
      sessionId: id(0x10a1),
      sellerId: null,
    }),
  );
  const seller = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: id(0xb1),
      sessionId: id(0x10b1),
      sellerId: id(0x5e11),
    }),
  );
  let reader: FakeReader;
  let ledger: FakeLedger;
  let deps: FinanceKpiDependencies;
  const today = (): string => NOW.toZonedDateTimeISO(zone.zoneOf(market)).toPlainDate().toString();

  beforeEach(() => {
    reader = new FakeReader();
    ledger = new FakeLedger();
    deps = {
      unitOfWork: {
        run: (_market: unknown, work: () => Promise<unknown>) => work(),
      } as unknown as AdminKpiDependencies['unitOfWork'],
      reader,
      zone,
      clock: new FixedClock(NOW),
      ledger,
    };
  });

  it('withholds net revenue and take rate until the ledger is ready (FE-066)', async () => {
    ledger.finished = false;
    const out = await new ViewMarketplaceFinanceKpis(gate, deps).execute(admin, { period: '7d' });
    expect(out.ok && out.value.net).toMatchObject({
      readiness: { ready: false, reason: 'backfill-not-finished' },
      current: null,
      previous: null,
      takeRate: { current: null, previous: null },
      deltas: { total: { state: 'na' }, commission: { state: 'na' } },
    });
  });

  it('answers net revenue of both ranges once ready: partial, no total, take rate from the commission only', async () => {
    ledger.match = busyWeek(today());
    const out = await new ViewMarketplaceFinanceKpis(gate, deps).execute(admin, { period: '7d' });
    if (!out.ok) throw new Error('expected an answer');
    const period = out.value.period;
    ledger.ranges.length = 0;
    reader.rows = [
      { ...emptyDay(today() as never), ordersPaid: 3, goodsAmount: 110_000n, goodsTax: 10_000n },
      {
        ...emptyDay(period.previous.to),
        ordersPaid: 3,
        goodsAmount: 110_000n,
        goodsTax: 10_000n,
      },
    ];
    ledger.sums = (range) =>
      range.from === period.current.from
        ? commissionSums(13_500n, 300n)
        : commissionSums(12_000n, 0n);
    const again = await new ViewMarketplaceFinanceKpis(gate, deps).execute(admin, {
      period: '7d',
    });
    if (!again.ok || again.value.net === null) throw new Error('expected net figures');
    const net = again.value.net;
    expect(ledger.ranges).toEqual([period.current, period.previous]);
    expect(net.readiness.ready).toBe(true);
    expect(net.current?.currency).toBe(zone.currencyOf(market));
    expect(net.current?.components.commission).toEqual({ status: 'available', amount: 13_200n });
    expect(net.current?.total).toEqual({
      status: 'partial',
      missing: ['deliveryMargin', 'platformFundedDiscounts', 'platformFundedCashback', 'fleetFees'],
    });
    expect(net.current?.total).not.toHaveProperty('amount');
    // 13,200 of 100,000 GMV without GST; the previous range 12,000 of 100,000.
    expect(net.takeRate.current).toMatchObject({
      status: 'partial',
      rateBp: 1320,
      basis: ['commission'],
    });
    expect(net.takeRate.previous).toMatchObject({ status: 'partial', rateBp: 1200 });
    expect(net.deltas.commission).toEqual({ value: 1000, direction: 'up', state: 'ok' });
    expect(net.deltas.total.state).toBe('na');
    expect(net.deltas.takeRateBp).toEqual({ value: 120, direction: 'up', state: 'ok' });
  });

  it('keeps GMV when only the ledger read fails (net is null)', async () => {
    ledger.failing = true;
    reader.rows = [{ ...emptyDay(today() as never), ordersPaid: 1, goodsAmount: 1_000n }];
    const out = await new ViewMarketplaceFinanceKpis(gate, deps).execute(admin, { period: '7d' });
    expect(out.ok && out.value.net).toBeNull();
    expect(out.ok && out.value.current.gmvWithTax).toBe(1_000n);
  });

  it('answers the orders by status of the Market days, refunded apart, same-day not available', async () => {
    reader.tallies = {
      paid: 20,
      cancelled: 1,
      delivered: 10,
      shipped: 5,
      refunded: { delivered: 1, shipped: 0, toShip: 1 },
    };
    const out = await new ViewMarketplaceOrderStatus(gate, deps).execute(admin, {
      period: '30d',
    });
    if (!out.ok) throw new Error('expected an answer');
    expect(out.value.period.current.to).toBe(today());
    expect(reader.tallyCalls).toEqual([
      {
        currency: zone.currencyOf(market),
        range: out.value.period.current,
        marketId: market.marketId,
      },
    ]);
    expect(out.value.counts).toEqual({
      paid: 20,
      toShip: 3,
      shipped: 5,
      delivered: 9,
      cancelled: 1,
      refunded: 2,
      cancelledRateBp: 500,
      refundedRateBp: 1000,
    });
    expect(out.value.sameDayShare).toEqual({ status: 'not-available', reason: 'not-reported' });
    expect(out.value.timezone).toBe(zone.zoneOf(market));
    expect(out.value.window).toEqual(windowOf(out.value.period.current, zone.zoneOf(market)));
  });

  it('answers the order status read as unavailable when the store fails, and refuses a seller', async () => {
    reader.orderStatusTallies = () => Promise.reject(new TypeError('down'));
    const useCase = new ViewMarketplaceOrderStatus(gate, deps);
    expect(await useCase.execute(admin, { period: '7d' })).toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
    expect((await useCase.execute(seller, { period: '7d' })).ok).toBe(false);
  });

  it('counts today in the Market day and reads the Market currency, current and previous', async () => {
    const out = await new ViewMarketplaceFinanceKpis(gate, deps).execute(admin, { period: '7d' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.period.current.to).toBe(today());
    expect(out.value.currency).toBe(zone.currencyOf(market));
    expect(reader.calls).toHaveLength(2);
    expect(new Set(reader.calls.map((call) => call.currency))).toEqual(
      new Set([zone.currencyOf(market)]),
    );
    expect(reader.calls[0]!.range).toEqual(out.value.period.current);
    expect(reader.calls[1]!.range).toEqual(out.value.period.previous);
    expect(out.value.series).toHaveLength(7);
    expect(out.value.previousSeries).toHaveLength(7);
  });

  it('puts the money of the days into the numbers, refunds apart', async () => {
    const day = today();
    reader.rows = [
      {
        ...emptyDay(day as never),
        ordersPaid: 2,
        goodsAmount: 40_000n,
        goodsTax: 3_636n,
        refunds: 1,
        refundGoodsAmount: -10_000n,
        refundGoodsTax: -909n,
      },
    ];
    reader.refreshedAt = NOW.subtract({ minutes: 3 });
    const out = await new ViewMarketplaceFinanceKpis(gate, deps).execute(admin, {
      period: 'today',
    });
    expect(out.ok && out.value.current).toMatchObject({
      gmvWithTax: 40_000n,
      refundedWithTax: 10_000n,
      netSalesWithTax: 30_000n,
      averageOrderWithTax: 20_000n,
    });
    expect(out.ok && out.value.refreshedAt).toEqual(NOW.subtract({ minutes: 3 }));
    expect(out.ok && out.value.deltas.gmvWithTax.state).toBe('na');
  });

  it('keeps the order numbers when only the sellers count cannot be read', async () => {
    reader.rows = [{ ...emptyDay(today() as never), ordersPaid: 5 }];
    reader.sellersWithOrders = () => Promise.reject(new TypeError('boom'));
    const out = await new ViewMarketplaceOperationsKpis(gate, deps).execute(admin, {
      period: 'month',
    });
    expect(out.ok && out.value.sellersWithOrders).toBeNull();
    expect(out.ok && out.value.current.ordersPaid).toBe(5);
  });

  it('answers the operations numbers with no money in them', async () => {
    reader.rows = [
      { ...emptyDay(today() as never), ordersPaid: 12, ordersShipped: 4, ordersShippedOnTime: 3 },
    ];
    reader.sellerCount = 9;
    const out = await new ViewMarketplaceOperationsKpis(gate, deps).execute(admin, {
      period: 'month',
    });
    expect(out.ok && out.value.current).toMatchObject({ ordersPaid: 12, onTimeRateBp: 7500 });
    expect(out.ok && out.value.sellersWithOrders).toBe(9);
    expect(
      JSON.stringify(out, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    ).not.toMatch(/gmv/i);
  });

  it('refuses a seller session and anyone who is not a platform admin acting as themselves', async () => {
    for (const useCase of [
      new ViewMarketplaceFinanceKpis(gate, deps),
      new ViewMarketplaceOperationsKpis(gate, deps),
    ]) {
      const out = await useCase.execute(seller, { period: '7d' });
      expect(out.ok).toBe(false);
    }
    expect(reader.calls).toHaveLength(0);
  });
  it("refuses a customer session and reads nothing (acting-as is covered by isPlatformAdminActor's own spec)", async () => {
    const customer = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId: id(0xc1),
        sessionId: id(0x10c1),
        sellerId: null,
      }),
    );
    for (const context of [customer]) {
      for (const useCase of [
        new ViewMarketplaceFinanceKpis(gate, deps),
        new ViewMarketplaceOperationsKpis(gate, deps),
      ]) {
        const out = await useCase.execute(context, { period: '7d' });
        expect(out.ok).toBe(false);
      }
    }
    expect(reader.calls).toHaveLength(0);
  });

  it('checks the money key itself: an admin with only the orders key reads operations, not finance', async () => {
    const ordersOnly = createUseCaseGate(markets, {
      check: (_context, declaration) =>
        Promise.resolve(
          JSON.stringify(declaration.rule).includes('ordering.order.view')
            ? { allowed: true as const }
            : { allowed: false as const, denial: { code: 'access.denied' as const } },
        ),
    });
    const finance = await new ViewMarketplaceFinanceKpis(ordersOnly, deps).execute(admin, {
      period: '7d',
    });
    expect(finance.ok).toBe(false);
    expect(reader.calls).toHaveLength(0);
    const operations = await new ViewMarketplaceOperationsKpis(ordersOnly, deps).execute(admin, {
      period: '7d',
    });
    expect(operations.ok).toBe(true);
  });
});

describe.each(TEST_MARKETS)('the top sellers read in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const zone = new RegistryMarketZone(markets);
  const admin = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: id(0xa1),
      sessionId: id(0x10a1),
      sellerId: null,
    }),
  );
  const seller = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: id(0xb1),
      sessionId: id(0x10b1),
      sellerId: id(0x5e11),
    }),
  );
  let reader: FakeReader;
  let deps: AdminKpiDependencies;

  beforeEach(() => {
    reader = new FakeReader();
    deps = {
      unitOfWork: {
        run: (_market: unknown, work: () => Promise<unknown>) => work(),
      } as unknown as AdminKpiDependencies['unitOfWork'],
      reader,
      zone,
      clock: new FixedClock(NOW),
    };
  });

  it('reads the current period only, in the Market currency, at most five, and derives the rates', async () => {
    reader.sellers = Array.from({ length: 7 }, (_, n) => ({
      sellerId: id(0x100 + n),
      ordersPaid: 10,
      goodsAmount: BigInt(1_000_000 - n),
      ordersShipped: 8,
      ordersShippedOnTime: 6,
      refundGoodsAmount: -10_000n,
    }));
    const out = await new ViewMarketplaceTopSellers(gate, deps).execute(admin, { period: '30d' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(reader.topCalls).toEqual([
      { currency: zone.currencyOf(market), range: out.value.period.current, limit: 5 },
    ]);
    expect(out.value.rows).toHaveLength(5);
    expect(out.value.rows[0]).toMatchObject({
      gmvWithTax: 1_000_000n,
      ordersPaid: 10,
      onTimeRateBp: 7500,
      refundRateBp: 100,
    });
  });

  it('refuses a seller session without reading, and a missing money key', async () => {
    expect(
      (await new ViewMarketplaceTopSellers(gate, deps).execute(seller, { period: '7d' })).ok,
    ).toBe(false);
    const denied = createUseCaseGate(markets, {
      check: () =>
        Promise.resolve({ allowed: false as const, denial: { code: 'access.denied' as const } }),
    });
    expect(
      (await new ViewMarketplaceTopSellers(denied, deps).execute(admin, { period: '7d' })).ok,
    ).toBe(false);
    expect(reader.topCalls).toHaveLength(0);
  });

  it('is access.unavailable when the read fails', async () => {
    reader.topSellers = () => Promise.reject(new TypeError('boom'));
    const out = await new ViewMarketplaceTopSellers(gate, deps).execute(admin, { period: '7d' });
    expect(!out.ok && out.error.code).toBe('access.unavailable');
  });
});

describe.each(TEST_MARKETS)('the top categories read in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const zone = new RegistryMarketZone(markets);
  const actor = (population: 'admin' | 'seller') =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: id(0xa1),
        sessionId: id(0x10a1),
        sellerId: population === 'seller' ? id(0x5e11) : null,
      }),
    );
  let reader: FakeReader;
  let deps: AdminKpiDependencies;

  beforeEach(() => {
    reader = new FakeReader();
    deps = {
      unitOfWork: {
        run: (_market: unknown, work: () => Promise<unknown>) => work(),
      } as unknown as AdminKpiDependencies['unitOfWork'],
      reader,
      zone,
      clock: new FixedClock(NOW),
    };
  });

  it('reads the current period only, in the Market currency, at most five, gross of refunds', async () => {
    reader.categories = Array.from({ length: 7 }, (_, n) => ({
      categoryId: id(0x200 + n),
      orders: 3,
      salesAmount: BigInt(100_000 - n),
      refundAmount: -5_000n,
    }));
    const out = await new ViewMarketplaceTopCategories(gate, deps).execute(actor('admin'), {
      period: '30d',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(reader.categoryCalls).toEqual([
      { currency: zone.currencyOf(market), range: out.value.period.current, limit: 5 },
    ]);
    expect(out.value.rows).toHaveLength(5);
    expect(out.value.rows[0]).toMatchObject({ salesWithTax: 100_000n, orders: 3 });
  });

  it('refuses a seller session and a missing money key without reading', async () => {
    expect(
      (
        await new ViewMarketplaceTopCategories(gate, deps).execute(actor('seller'), {
          period: '7d',
        })
      ).ok,
    ).toBe(false);
    const denied = createUseCaseGate(markets, {
      check: () =>
        Promise.resolve({ allowed: false as const, denial: { code: 'access.denied' as const } }),
    });
    expect(
      (
        await new ViewMarketplaceTopCategories(denied, deps).execute(actor('admin'), {
          period: '7d',
        })
      ).ok,
    ).toBe(false);
    expect(reader.categoryCalls).toHaveLength(0);
  });
});
