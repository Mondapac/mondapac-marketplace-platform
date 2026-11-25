import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
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
import type { PermissionKey } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import type {
  DiscountCostAnswer,
  FinanceAnswer,
  OperationsAnswer,
  OrderStatusAnswer,
  MonthlyTargetAnswer,
  OrdersByStateAnswer,
  ShoppingFunnelAnswer,
  AbandonedCartsAnswer,
  ReportingKpiFacade,
  TopCategoriesAnswer,
  TopSellersAnswer,
} from '../../reporting';
import type { DashboardViewer } from './ports/viewer-permissions';
import { ViewAdminKpis, type AdminKpisDependencies } from './use-cases/view-admin-kpis.use-case';
import { adminKpisBody } from '../presentation/dashboard.dto';

// The admin KPI composer (dashboards upgrade phase 5): each section is asked only when the viewer
// holds its key, a slow or failing section answers `error` and the other still answers, and the
// body turns money into strings.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const gate = createUseCaseGate(markets, {
  check: () => Promise.resolve({ allowed: true as const }),
});
const NOW = Temporal.Instant.from('2026-11-22T01:00:00Z');
const ORDERS = 'ordering.order.view' as PermissionKey;
const MONEY = 'commission-payouts.settlement.view' as PermissionKey;
const PROMO_MANAGE = 'promotions.promotion.manage' as PermissionKey;
const TARGET = 'settings.monthly-revenue-target.view' as PermissionKey;

const operations = { period: { id: '7d' }, sellersWithOrders: 3 } as unknown as OperationsAnswer;
const finance = {
  period: {
    id: '7d',
    current: { from: '2026-11-16', to: '2026-11-22' },
    previous: { from: '2026-11-09', to: '2026-11-15' },
    days: 7,
  },
  currency: 'AUD',
  generatedAt: NOW,
  refreshedAt: NOW.subtract({ minutes: 2 }),
  current: {
    gmvWithTax: 123_456n,
    gmvWithoutTax: 112_233n,
    refundedWithTax: 0n,
    refundRateBp: 0,
    netSalesWithTax: 123_456n,
    averageOrderWithTax: null,
  },
  previous: {
    gmvWithTax: 0n,
    gmvWithoutTax: 0n,
    refundedWithTax: 0n,
    refundRateBp: null,
    netSalesWithTax: 0n,
    averageOrderWithTax: null,
  },
  deltas: {},
  series: [{ day: '2026-11-22', gmvWithTax: 5n, gmvWithoutTax: 4n, refundedWithTax: 1n }],
  previousSeries: [],
  net: {
    readiness: {
      ready: true,
      reason: 'ready',
      backfillFinished: true,
      backfillFailedFacts: 0,
      matchedSellerOrders: 9,
      window: { from: '2026-11-15', to: '2026-11-21' },
      days: [],
    },
    current: {
      currency: 'AUD',
      commissionCharged: 15_000n,
      commissionRefunded: 184n,
      components: {
        commission: { status: 'available', amount: 14_816n },
        deliveryMargin: { status: 'not-available', reason: 'not-reported' },
        platformFundedDiscounts: { status: 'not-available', reason: 'not-reported' },
        platformFundedCashback: { status: 'not-available', reason: 'not-reported' },
        fleetFees: { status: 'not-available', reason: 'not-recorded' },
      },
      total: {
        status: 'partial',
        missing: [
          'deliveryMargin',
          'platformFundedDiscounts',
          'platformFundedCashback',
          'fleetFees',
        ],
      },
    },
    previous: null,
    takeRate: {
      current: {
        status: 'partial',
        rateBp: 1320,
        basis: ['commission'],
        missing: [
          'deliveryMargin',
          'platformFundedDiscounts',
          'platformFundedCashback',
          'fleetFees',
        ],
      },
      previous: { status: 'no-sales' },
    },
    deltas: {
      commission: { value: 0, direction: 'flat', state: 'na' },
      total: { value: 0, direction: 'flat', state: 'na' },
      takeRateBp: { value: 0, direction: 'flat', state: 'na' },
    },
  },
} as unknown as FinanceAnswer;

const topSellers = {
  period: finance.period,
  currency: 'AUD',
  generatedAt: NOW,
  rows: [
    {
      sellerId: id(0x51),
      gmvWithTax: 1_842_000n,
      ordersPaid: 311,
      onTimeRateBp: 9700,
      refundRateBp: 60,
    },
    {
      sellerId: id(0x52),
      gmvWithTax: 900_000n,
      ordersPaid: 20,
      onTimeRateBp: null,
      refundRateBp: null,
    },
  ],
} as unknown as TopSellersAnswer;

const NIL = '00000000-0000-0000-0000-000000000000';
const topCategories = {
  period: finance.period,
  currency: 'AUD',
  generatedAt: NOW,
  rows: [
    { categoryId: id(0x61), salesWithTax: 500_000n, orders: 40 },
    { categoryId: NIL, salesWithTax: 20_000n, orders: 2 },
  ],
} as unknown as TopCategoriesAnswer;

const ordersByState = {
  period: finance.period,
  generatedAt: NOW,
  byState: {
    status: 'available',
    paid: 400,
    states: [{ state: 'QLD', orders: 300, shareBp: 7500 }],
    other: null,
    unknown: { orders: 100, shareBp: 2500 },
  },
} as unknown as OrdersByStateAnswer;

const monthlyTarget: MonthlyTargetAnswer = {
  generatedAt: NOW,
  timezone: 'Australia/Brisbane',
  currency: 'AUD',
  refreshedAt: null,
  figures: {
    month: '2026-11',
    lastMonth: '2026-10',
    daysInMonth: 30,
    dayOfMonth: 22,
    daysLeft: 9,
    monthToDate: 190_560_00n,
    lastMonthTotal: 221_040_00n,
    forecast: { status: 'estimate', amount: 248_600_00n },
    target: 240_000_00n,
    progressBp: 7940,
    paceBp: 10358,
    toGo: 49_440_00n,
    perDayToGo: 5_493_33n,
  },
} as unknown as MonthlyTargetAnswer;

const NA = { value: 0, direction: 'flat', state: 'na' } as const;
const shoppingFunnel = {
  period: finance.period,
  generatedAt: NOW,
  funnel: {
    status: 'available',
    viewed: { count: 120, rateBp: null, change: NA, rateChange: NA },
    carted: { count: 30, rateBp: 2500, change: NA, rateChange: NA },
    checkedOut: { count: 12, rateBp: 4000, change: NA, rateChange: NA },
    paid: { count: null, rateBp: null, change: NA, rateChange: NA },
    recordedDays: 6,
    periodDays: 7,
  },
} as unknown as ShoppingFunnelAnswer;

const discountCost: DiscountCostAnswer = {
  period: finance.period,
  generatedAt: NOW,
  currency: 'AUD',
  cost: {
    status: 'available',
    orders: 42,
    amount: 50_000n,
    platformShare: 30_000n,
    sellerShare: 20_000n,
    platformShareBp: 6000,
    change: { value: 2500, direction: 'up', state: 'ok' },
    previousAmount: 40_000n,
    byKind: [
      { kind: 'promotion', uses: 40, amount: 40_000n, platformShare: 20_000n, shareBp: 8000 },
      { kind: 'first-order', uses: 5, amount: 10_000n, platformShare: 10_000n, shareBp: 2000 },
      { kind: 'free-shipping', uses: null, amount: null, platformShare: null, shareBp: null },
    ],
    released: null,
  },
};

const abandonedCarts = {
  period: finance.period,
  generatedAt: NOW,
  abandonedCarts: {
    status: 'available',
    carts: 42,
    approximateValue: { amount: 412_600n, currency: 'AUD' },
    asOfDay: '2026-11-23',
    change: NA,
    recordedDays: 6,
    periodDays: 7,
  },
} as unknown as AbandonedCartsAnswer;

const orderStatus: OrderStatusAnswer = {
  period: finance.period,
  timezone: 'Australia/Brisbane',
  window: {
    from: Temporal.Instant.from('2026-11-15T14:00:00Z'),
    to: Temporal.Instant.from('2026-11-22T14:00:00Z'),
  },
  generatedAt: NOW,
  counts: {
    paid: 400,
    toShip: 20,
    shipped: 60,
    delivered: 300,
    cancelled: 12,
    refunded: 8,
    cancelledRateBp: 300,
    refundedRateBp: 200,
  },
  sameDayShare: { status: 'available', sameDay: 80, paid: 400, rateBp: 2000 },
};

const CATALOG_VIEW = 'catalog.product.view' as PermissionKey;
const SELLERS_VIEW = 'sellers.seller.view' as PermissionKey;
const CERTS_VIEW = 'certification.seller-certificate.view' as PermissionKey;
const DISPUTES_VIEW = 'commission-payouts.dispute.view' as PermissionKey;
const queueCount = (count: number) =>
  ok({ count, overdue: 0, oldestAt: null }) as ReturnType<
    typeof ok<{ count: number; overdue: number; oldestAt: null }>
  >;
let disputeQueries: { from: Temporal.Instant; to: Temporal.Instant }[] = [];
const queues = (
  overrides: {
    claims?: () => Promise<unknown>;
    unhealthy?: () => Promise<unknown>;
    listings?: () => Promise<unknown>;
    expiring?: () => Promise<unknown>;
    holds?: () => Promise<unknown>;
    disputes?: () => Promise<unknown>;
  } = {},
): AdminKpisDependencies['queues'] =>
  ({
    catalog: {
      claimsWithoutCertificate: overrides.claims ?? (() => Promise.resolve(queueCount(2))),
    },
    sellers: {
      unhealthySellers: overrides.unhealthy ?? (() => Promise.resolve(queueCount(14))),
    },
    search: {
      liveListings:
        overrides.listings ?? (() => Promise.resolve(ok({ active: 8_412, outOfStock: 261 }))),
    },
    certification: {
      expiringCertificates:
        overrides.expiring ??
        ((_context: unknown, query: { now: Temporal.Instant }) =>
          Promise.resolve(ok({ count: 6, withinDays: 30, until: query.now.add({ hours: 744 }) }))),
    },
    commissionPayouts: {
      payoutHolds: overrides.holds ?? (() => Promise.resolve(queueCount(5))),
      disputesOpened:
        overrides.disputes ??
        ((_context: unknown, query: { from: Temporal.Instant; to: Temporal.Instant }) => {
          disputeQueries.push({ from: query.from, to: query.to });
          return Promise.resolve(ok({ count: 2 }));
        }),
    },
  }) as unknown as AdminKpisDependencies['queues'];

describe.each(TEST_MARKETS)('the admin KPIs composer in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const admin = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: id(0xa1),
      sessionId: id(0x10a1),
      sellerId: null,
    }),
  );
  const viewer = (keys: readonly PermissionKey[]): DashboardViewer => ({
    population: 'admin',
    sellerId: null,
    sellerAccessState: null,
    permissionKeys: keys,
  });
  let asked: string[];
  let facade: ReportingKpiFacade;
  let inputs: unknown[] = [];
  const build = (keys: readonly PermissionKey[], timeoutMs = 50): ViewAdminKpis => {
    const deps: AdminKpisDependencies = {
      viewer: { describe: () => Promise.resolve(ok(viewer(keys))) },
      reporting: facade,
      queues: queues(),
      catalog: {
        categoryTree: () =>
          Promise.resolve(
            ok([{ id: id(0x61), parentId: null, slug: 'meat', name: 'Fresh meat', depth: 0 }]),
          ),
      },
      sellers: {
        sellerSummaries: (_context: unknown, ids: readonly Id<'Seller'>[]) =>
          Promise.resolve(
            ok(
              ids.map((sellerId) => ({
                sellerId,
                exists: true,
                storeName: sellerId === id(0x51) ? 'Al-Noor Butchery' : null,
              })),
            ),
          ),
      },
      clock: new FixedClock(NOW),
      timeoutMs,
    };
    return new ViewAdminKpis(gate, deps);
  };

  beforeEach(() => {
    asked = [];
    disputeQueries = [];
    inputs = [];
    facade = {
      // The Market's today in the fake is 2026-11-22: a range past it is refused.
      resolvePeriod: (_context, period) =>
        typeof period !== 'string' && period.to > '2026-11-22'
          ? err({ code: 'validation.failed', fields: [{ path: 'to', code: 'future' }] })
          : ok(finance.period),
      marketplaceOrderStatus: () => {
        asked.push('orders-by-status');
        return Promise.resolve(ok(orderStatus));
      },
      marketplaceOrdersByState: () => {
        asked.push('orders-by-state');
        return Promise.resolve(ok(ordersByState));
      },
      marketplaceMonthlyTarget: () => {
        asked.push('market-target');
        return Promise.resolve(ok(monthlyTarget));
      },
      marketplaceShoppingFunnel: () => {
        asked.push('shopping-funnel');
        return Promise.resolve(ok(shoppingFunnel));
      },
      marketplaceAbandonedCarts: () => {
        asked.push('abandoned-carts');
        return Promise.resolve(ok(abandonedCarts));
      },
      marketplaceDiscountCost: () => {
        asked.push('discount-cost');
        return Promise.resolve(ok(discountCost));
      },
      marketplaceOperations: (_context, input) => {
        asked.push('operations');
        inputs.push(input);
        return Promise.resolve(ok(operations));
      },
      marketplaceFinance: () => {
        asked.push('finance');
        return Promise.resolve(ok(finance));
      },
      marketplaceTopCategories: () => {
        asked.push('top-categories');
        return Promise.resolve(ok(topCategories));
      },
      marketplaceTopSellers: () => {
        asked.push('top-sellers');
        return Promise.resolve(ok(topSellers));
      },
      // Not composed by the dashboard yet (dashboards v2, PR 6 and PR 8).
      marketplaceNetRevenue: () => Promise.reject(new Error('not used')),
      sellerNetEarnings: () => Promise.reject(new Error('not used')),
    };
  });

  it('passes a custom range to the sections and names it custom (dashboards v2, PR 5)', async () => {
    const range = { from: '2026-10-01', to: '2026-10-31' } as const;
    const out = await build([ORDERS]).execute(admin, { period: range as never });
    expect(out.ok && out.value.period).toBe('custom');
    expect(inputs).toEqual([{ period: range }]);
  });

  it('refuses a range that ends after the Market today once, before any section is asked', async () => {
    const out = await build([ORDERS, MONEY]).execute(admin, {
      period: { from: '2026-11-20', to: '2026-11-23' } as never,
    });
    expect(out).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'to', code: 'future' }] },
    });
    expect(asked).toEqual([]);
  });

  it('asks only the sections whose keys the viewer holds', async () => {
    const out = await build([MONEY]).execute(admin, { period: '7d' });
    expect(asked.sort()).toEqual(['finance', 'top-categories', 'top-sellers']);
    expect(out.ok && out.value.operations).toBeNull();
    expect(out.ok && out.value.finance?.status).toBe('ok');
  });

  it('names the top sellers from the public store name and never asks without the money key', async () => {
    const out = await build([MONEY]).execute(admin, { period: '7d' });
    const body = out.ok ? adminKpisBody(out.value) : null;
    expect(body?.topSellers?.kpis?.rows[0]).toMatchObject({
      storeName: 'Al-Noor Butchery',
      gmvWithTax: { amountMinor: '1842000', currency: 'AUD' },
      ordersPaid: 311,
    });
    expect(body?.topSellers?.kpis?.rows[1]?.storeName).toBeNull();
    asked.length = 0;
    const ordersOnly = await build([ORDERS]).execute(admin, { period: '7d' });
    expect(ordersOnly.ok && ordersOnly.value.topSellers).toBeNull();
    expect(asked.sort()).toEqual([
      'abandoned-carts',
      'operations',
      'orders-by-state',
      'orders-by-status',
      'shopping-funnel',
    ]);
    expect(ordersOnly.ok && ordersOnly.value.ordersByState).toEqual({
      status: 'ok',
      value: ordersByState,
    });
  });

  it('maps the orders-by-state section for the body: available, not-enough-data, error, and null without the key', async () => {
    const full = await build([ORDERS]).execute(admin, { period: '7d' });
    if (!full.ok) throw new Error('expected an answer');
    // The operations fixture is partial: map only the orders sections.
    const base = { ...full.value, operations: null };
    expect(adminKpisBody(base).ordersByState).toEqual({
      status: 'ok',
      kpis: {
        status: 'available',
        paid: 400,
        states: [{ state: 'QLD', orders: 300, shareBp: 7500 }],
        other: null,
        unknown: { orders: 100, shareBp: 2500 },
      },
    });
    const few = {
      ...base,
      ordersByState: {
        status: 'ok' as const,
        value: {
          ...ordersByState,
          byState: { status: 'not-enough-data' as const, paid: 3, minimum: 5 },
        },
      },
    };
    expect(adminKpisBody(few).ordersByState).toEqual({
      status: 'ok',
      kpis: { status: 'not-enough-data', paid: 3, minimum: 5 },
    });
    expect(adminKpisBody({ ...base, ordersByState: { status: 'error' } }).ordersByState).toEqual({
      status: 'error',
    });
    const none = await build([]).execute(admin, { period: '7d' });
    expect(none.ok && none.value.ordersByState).toBeNull();
    // A failing section leaves the others answering.
    facade.marketplaceOrdersByState = () => Promise.reject(new TypeError('boom'));
    const failed = await build([ORDERS]).execute(admin, { period: '7d' });
    expect(failed.ok && failed.value.ordersByState).toEqual({ status: 'error' });
    expect(failed.ok && failed.value.ordersByStatus?.status).toBe('ok');
  });

  it('asks the market target only with the money key and the target key, and maps it for the body', async () => {
    const both = await build([MONEY, TARGET]).execute(admin, { period: '7d' });
    expect(asked).toContain('market-target');
    expect(both.ok && both.value.marketTarget).toEqual({ status: 'ok', value: monthlyTarget });
    if (!both.ok) throw new Error('expected an answer');
    expect(adminKpisBody(both.value).marketTarget).toEqual({
      status: 'ok',
      kpis: {
        month: '2026-11',
        lastMonth: '2026-10',
        timezone: 'Australia/Brisbane',
        currency: 'AUD',
        daysInMonth: 30,
        dayOfMonth: 22,
        daysLeft: 9,
        monthToDate: '19056000',
        lastMonthTotal: '22104000',
        forecast: { status: 'estimate', amount: '24860000' },
        target: '24000000',
        progressBp: 7940,
        paceBp: 10358,
        toGo: '4944000',
        perDayToGo: '549333',
        refreshedAt: null,
      },
    });
    const early = {
      ...both.value,
      marketTarget: {
        status: 'ok' as const,
        value: {
          ...monthlyTarget,
          figures: {
            ...monthlyTarget.figures,
            target: null,
            progressBp: null,
            paceBp: null,
            toGo: null,
            perDayToGo: null,
            forecast: {
              status: 'not-enough-data' as const,
              daysElapsed: 1,
              minimumDays: 3,
            },
          },
        },
      },
    };
    expect(adminKpisBody(early).marketTarget?.kpis).toMatchObject({
      target: null,
      paceBp: null,
      forecast: { status: 'not-enough-data', daysElapsed: 1, minimumDays: 3 },
    });
    for (const keys of [[MONEY], [TARGET], [ORDERS, TARGET]] as const) {
      asked.length = 0;
      const out = await build(keys).execute(admin, { period: '7d' });
      expect(out.ok && out.value.marketTarget).toBeNull();
      expect(asked).not.toContain('market-target');
    }
    // A refusal by the owner leaves it out; a failure or a slow read is `error`, alone.
    facade.marketplaceMonthlyTarget = () => Promise.resolve(err({ code: 'access.denied' }));
    const refused = await build([MONEY, TARGET]).execute(admin, { period: '7d' });
    expect(refused.ok && refused.value.marketTarget).toBeNull();
    facade.marketplaceMonthlyTarget = () => Promise.reject(new TypeError('boom'));
    const failed = await build([MONEY, TARGET]).execute(admin, { period: '7d' });
    expect(failed.ok && failed.value.marketTarget).toEqual({ status: 'error' });
    expect(failed.ok && failed.value.finance?.status).toBe('ok');
    expect(
      adminKpisBody({ ...both.value, marketTarget: { status: 'error' } }).marketTarget,
    ).toEqual({ status: 'error' });
    facade.marketplaceMonthlyTarget = () => new Promise(() => undefined);
    const slow = await build([MONEY, TARGET], 5).execute(admin, { period: '7d' });
    expect(slow.ok && slow.value.marketTarget).toEqual({ status: 'error' });
  });

  it('maps the shopping-funnel section: hidden steps stay null, not-enough-data, error, and null without the key', async () => {
    const full = await build([ORDERS]).execute(admin, { period: '7d' });
    if (!full.ok) throw new Error('expected an answer');
    const base = { ...full.value, operations: null };
    expect(adminKpisBody(base).shoppingFunnel).toEqual({
      status: 'ok',
      kpis: {
        status: 'available',
        viewed: { count: 120, rateBp: null, change: NA, rateChange: NA },
        carted: { count: 30, rateBp: 2500, change: NA, rateChange: NA },
        checkedOut: { count: 12, rateBp: 4000, change: NA, rateChange: NA },
        paid: { count: null, rateBp: null, change: NA, rateChange: NA },
        recordedDays: 6,
        periodDays: 7,
      },
    });
    const few = {
      ...base,
      shoppingFunnel: {
        status: 'ok' as const,
        value: {
          ...shoppingFunnel,
          funnel: {
            status: 'not-enough-data' as const,
            minimum: 20,
            recordedDays: 7,
            periodDays: 7,
          },
        },
      },
    };
    expect(adminKpisBody(few).shoppingFunnel).toEqual({
      status: 'ok',
      kpis: { status: 'not-enough-data', minimum: 20, recordedDays: 7, periodDays: 7 },
    });
    const none = await build([MONEY]).execute(admin, { period: '7d' });
    expect(none.ok && none.value.shoppingFunnel).toBeNull();
    facade.marketplaceShoppingFunnel = () => Promise.reject(new TypeError('boom'));
    const failed = await build([ORDERS]).execute(admin, { period: '7d' });
    expect(failed.ok && failed.value.shoppingFunnel).toEqual({ status: 'error' });
    expect(failed.ok && failed.value.ordersByState?.status).toBe('ok');
  });

  it('maps the discount-cost section: money as strings, not-enough-data, error, and null without both keys', async () => {
    const full = await build([MONEY, PROMO_MANAGE]).execute(admin, { period: '7d' });
    if (!full.ok) throw new Error('expected an answer');
    const money = (amountMinor: string) => ({ amountMinor, currency: 'AUD' });
    expect(adminKpisBody(full.value).discountCost).toEqual({
      status: 'ok',
      kpis: {
        status: 'available',
        orders: 42,
        amount: money('50000'),
        platformShare: money('30000'),
        sellerShare: money('20000'),
        platformShareBp: 6000,
        change: { value: 2500, direction: 'up', state: 'ok' },
        previousAmount: money('40000'),
        byKind: [
          {
            kind: 'promotion',
            uses: 40,
            amount: money('40000'),
            platformShare: money('20000'),
            shareBp: 8000,
          },
          {
            kind: 'first-order',
            uses: 5,
            amount: money('10000'),
            platformShare: money('10000'),
            shareBp: 2000,
          },
          // A kind of 1 to 4 uses is held back whole, and so is a released of 1 to 4 orders.
          { kind: 'free-shipping', uses: null, amount: null, platformShare: null, shareBp: null },
        ],
        released: null,
      },
    });
    const few = {
      ...full.value,
      discountCost: {
        status: 'ok' as const,
        value: {
          ...discountCost,
          cost: { status: 'not-enough-data' as const, orders: 3, minimum: 5 },
        },
      },
    };
    expect(adminKpisBody(few).discountCost).toEqual({
      status: 'ok',
      kpis: { status: 'not-enough-data', orders: 3, minimum: 5 },
    });
    // Either key alone leaves the section out: spend is for promotion managers with the money key.
    for (const keys of [[ORDERS], [MONEY], [PROMO_MANAGE]]) {
      asked.length = 0;
      const none = await build(keys).execute(admin, { period: '7d' });
      expect(none.ok && none.value.discountCost).toBeNull();
      expect(asked).not.toContain('discount-cost');
    }
    facade.marketplaceDiscountCost = () => Promise.reject(new TypeError('boom'));
    const failed = await build([MONEY, PROMO_MANAGE]).execute(admin, { period: '7d' });
    expect(failed.ok && failed.value.discountCost).toEqual({ status: 'error' });
    expect(failed.ok && failed.value.finance?.status).toBe('ok');
    // The owner refusing the key leaves the section out, like a key the viewer lacks.
    facade.marketplaceDiscountCost = () => Promise.resolve(err({ code: 'access.denied' }));
    const refused = await build([MONEY, PROMO_MANAGE]).execute(admin, { period: '7d' });
    expect(refused.ok && refused.value.discountCost).toBeNull();
  });

  it('maps the abandoned-carts section: approximate value as a string, not-enough-data, error, and null without the key', async () => {
    const full = await build([ORDERS]).execute(admin, { period: '7d' });
    if (!full.ok) throw new Error('expected an answer');
    const base = { ...full.value, operations: null };
    expect(adminKpisBody(base).abandonedCarts).toEqual({
      status: 'ok',
      kpis: {
        status: 'available',
        carts: 42,
        approximateValue: { amountMinor: '412600', currency: 'AUD' },
        asOfDay: '2026-11-23',
        change: NA,
        recordedDays: 6,
        periodDays: 7,
      },
    });
    const few = {
      ...base,
      abandonedCarts: {
        status: 'ok' as const,
        value: {
          ...abandonedCarts,
          abandonedCarts: {
            status: 'not-enough-data' as const,
            minimum: 5,
            recordedDays: 7,
            periodDays: 7,
          },
        },
      },
    };
    expect(adminKpisBody(few).abandonedCarts).toEqual({
      status: 'ok',
      kpis: { status: 'not-enough-data', minimum: 5, recordedDays: 7, periodDays: 7 },
    });
    const none = await build([MONEY]).execute(admin, { period: '7d' });
    expect(none.ok && none.value.abandonedCarts).toBeNull();
    facade.marketplaceAbandonedCarts = () => Promise.reject(new TypeError('boom'));
    const failed = await build([ORDERS]).execute(admin, { period: '7d' });
    expect(failed.ok && failed.value.abandonedCarts).toEqual({ status: 'error' });
    expect(failed.ok && failed.value.shoppingFunnel?.status).toBe('ok');
  });

  it('names the top categories from the live tree, null for a category it does not have', async () => {
    const out = await build([MONEY]).execute(admin, { period: '7d' });
    const body = out.ok ? adminKpisBody(out.value) : null;
    expect(body?.topCategories?.kpis?.rows[0]).toMatchObject({
      name: 'Fresh meat',
      salesWithTax: { amountMinor: '500000', currency: 'AUD' },
      orders: 40,
    });
    expect(body?.topCategories?.kpis?.rows[1]?.name).toBeNull();
    const ordersOnly = await build([ORDERS]).execute(admin, { period: '7d' });
    expect(ordersOnly.ok && ordersOnly.value.topCategories).toBeNull();
  });

  const NO_HEALTH = {
    uncertifiedListings: null,
    sellersAtRisk: null,
    listings: null,
    certificatesExpiring: null,
    payoutsOnHold: null,
    disputeRate: null,
  };

  it('answers the health counts the viewer may see, each under its own key', async () => {
    const both = await build([CATALOG_VIEW, SELLERS_VIEW]).execute(admin, { period: '7d' });
    expect(both.ok && both.value.health).toEqual({
      ...NO_HEALTH,
      uncertifiedListings: { status: 'ok', count: 2 },
      sellersAtRisk: { status: 'ok', count: 14 },
      listings: { status: 'ok', active: 8_412, outOfStock: 261, outOfStockRateBp: 310 },
    });
    const one = await build([SELLERS_VIEW]).execute(admin, { period: '7d' });
    expect(one.ok && one.value.health).toEqual({
      ...NO_HEALTH,
      sellersAtRisk: { status: 'ok', count: 14 },
    });
    const ordersOnly = await build([ORDERS]).execute(admin, { period: '7d' });
    expect(ordersOnly.ok && ordersOnly.value.health).toBeNull();
  });

  it('answers certificates expiring, payout holds (amount not available) and the dispute rate', async () => {
    // The operations fixture is partial; this test reads the body of the other sections.
    facade.marketplaceOperations = () => Promise.resolve(err({ code: 'access.denied' as const }));
    const out = await build([CERTS_VIEW, MONEY, DISPUTES_VIEW, ORDERS]).execute(admin, {
      period: '7d',
    });
    expect(out.ok && out.value.health).toEqual({
      ...NO_HEALTH,
      certificatesExpiring: { status: 'ok', count: 6, withinDays: 30 },
      payoutsOnHold: {
        status: 'ok',
        count: 5,
        amount: { status: 'not-available', reason: 'not-recorded' },
      },
      // 2 chargebacks over the 400 seller orders paid in the same Market days.
      disputeRate: { status: 'ok', disputes: 2, paidSellerOrders: 400, rateBp: 50 },
    });
    // The chargebacks are counted over the orders-by-status answer's own window.
    expect(disputeQueries).toEqual([orderStatus.window]);
    const body = out.ok ? adminKpisBody(out.value) : null;
    expect(body?.health?.payoutsOnHold?.amount).toEqual({
      status: 'not-available',
      reason: 'not-recorded',
    });
  });

  it('needs the orders key for the dispute rate, and answers error when its denominator failed', async () => {
    const disputesOnly = await build([DISPUTES_VIEW]).execute(admin, { period: '7d' });
    expect(disputesOnly.ok && disputesOnly.value.health).toBeNull();
    facade.marketplaceOrderStatus = () => Promise.reject(new TypeError('boom'));
    const out = await build([DISPUTES_VIEW, ORDERS]).execute(admin, { period: '7d' });
    expect(out.ok && out.value.ordersByStatus).toEqual({ status: 'error' });
    expect(out.ok && out.value.health?.disputeRate).toEqual({ status: 'error' });
    expect(disputeQueries).toEqual([]);
  });

  it('answers orders by status under the orders key, with the same-day share not available', async () => {
    // The operations fixture is partial; this test reads the body of the other sections.
    facade.marketplaceOperations = () => Promise.resolve(err({ code: 'access.denied' as const }));
    const out = await build([ORDERS]).execute(admin, { period: '7d' });
    const body = out.ok ? adminKpisBody(out.value) : null;
    expect(body?.ordersByStatus).toEqual({
      status: 'ok',
      kpis: {
        ...orderStatus.counts,
        sameDayShare: { status: 'available', sameDay: 80, paid: 400, rateBp: 2000 },
      },
    });
    for (const [share, body] of [
      [
        { status: 'not-enough-data', paid: 3, minimum: 5 },
        { status: 'not-enough-data', paid: 3, minimum: 5 },
      ],
      [
        { status: 'not-available', reason: 'method-unknown', unknownMethod: 2 },
        { status: 'not-available', reason: 'method-unknown', unknownMethod: 2 },
      ],
    ] as const) {
      facade.marketplaceOrderStatus = () =>
        Promise.resolve(ok({ ...orderStatus, sameDayShare: share }));
      const again = await build([ORDERS]).execute(admin, { period: '7d' });
      const sent = again.ok ? adminKpisBody(again.value) : null;
      expect(sent?.ordersByStatus?.kpis?.sameDayShare).toEqual(body);
    }
    const moneyOnly = await build([MONEY]).execute(admin, { period: '7d' });
    expect(moneyOnly.ok && moneyOnly.value.ordersByStatus).toBeNull();
  });

  it('marks the new health numbers as error when they fail, are refused or are slow', async () => {
    const deps: AdminKpisDependencies = {
      viewer: {
        describe: () =>
          Promise.resolve(ok(viewer([CATALOG_VIEW, CERTS_VIEW, MONEY, DISPUTES_VIEW, ORDERS]))),
      },
      reporting: facade,
      sellers: { sellerSummaries: () => Promise.resolve(ok([])) },
      catalog: { categoryTree: () => Promise.resolve(ok([])) },
      queues: queues({
        listings: () => Promise.reject(new TypeError('boom')),
        expiring: () => Promise.resolve(err({ code: 'access.denied' as const })),
        holds: () => new Promise(() => undefined),
        disputes: () => Promise.resolve(err({ code: 'access.unavailable' as const })),
      }),
      clock: new FixedClock(NOW),
      timeoutMs: 20,
    };
    const out = await new ViewAdminKpis(gate, deps).execute(admin, { period: '7d' });
    expect(out.ok && out.value.health).toMatchObject({
      listings: { status: 'error' },
      certificatesExpiring: { status: 'error' },
      payoutsOnHold: { status: 'error' },
      disputeRate: { status: 'error' },
    });
  });

  it('marks a health count that fails, is refused or is slow as error, never zero', async () => {
    const deps: AdminKpisDependencies = {
      viewer: { describe: () => Promise.resolve(ok(viewer([CATALOG_VIEW, SELLERS_VIEW]))) },
      reporting: facade,
      sellers: { sellerSummaries: () => Promise.resolve(ok([])) },
      catalog: { categoryTree: () => Promise.resolve(ok([])) },
      queues: queues({
        claims: () => Promise.reject(new TypeError('boom')),
        unhealthy: () => new Promise(() => undefined),
      }),
      clock: new FixedClock(NOW),
      timeoutMs: 20,
    };
    const out = await new ViewAdminKpis(gate, deps).execute(admin, { period: '7d' });
    const body = out.ok ? adminKpisBody(out.value) : null;
    expect(body?.health).toEqual({
      ...NO_HEALTH,
      uncertifiedListings: { status: 'error' },
      sellersAtRisk: { status: 'error' },
      listings: { status: 'ok', active: 8_412, outOfStock: 261, outOfStockRateBp: 310 },
    });
  });

  it('marks a health count as error when its owner refuses the viewer', async () => {
    const deps: AdminKpisDependencies = {
      viewer: { describe: () => Promise.resolve(ok(viewer([CATALOG_VIEW, SELLERS_VIEW]))) },
      reporting: facade,
      sellers: { sellerSummaries: () => Promise.resolve(ok([])) },
      catalog: { categoryTree: () => Promise.resolve(ok([])) },
      queues: queues({
        claims: () => Promise.resolve(err({ code: 'access.denied' as const })),
      }),
      clock: new FixedClock(NOW),
      timeoutMs: 50,
    };
    const out = await new ViewAdminKpis(gate, deps).execute(admin, { period: '7d' });
    const body = out.ok ? adminKpisBody(out.value) : null;
    expect(body?.health?.uncertifiedListings).toEqual({ status: 'error' });
    expect(body?.health?.sellersAtRisk?.status).toBe('ok');
  });

  it('maps a health section to the response body with its counts', async () => {
    const out = await build([CATALOG_VIEW, SELLERS_VIEW], 50).execute(admin, { period: '7d' });
    const body = out.ok ? adminKpisBody(out.value) : null;
    expect(body?.health).toMatchObject({
      uncertifiedListings: { status: 'ok' },
      sellersAtRisk: { status: 'ok' },
    });
  });

  it('keeps the money when the store names cannot be read', async () => {
    const deps: AdminKpisDependencies = {
      viewer: { describe: () => Promise.resolve(ok(viewer([MONEY]))) },
      reporting: facade,
      sellers: { sellerSummaries: () => Promise.reject(new TypeError('boom')) },
      catalog: { categoryTree: () => Promise.reject(new TypeError('boom')) },
      queues: queues(),
      clock: new FixedClock(NOW),
      timeoutMs: 50,
    };
    const out = await new ViewAdminKpis(gate, deps).execute(admin, { period: '7d' });
    const body = out.ok ? adminKpisBody(out.value) : null;
    expect(body?.topSellers?.status).toBe('ok');
    expect(body?.topSellers?.kpis?.rows.every((row) => row.storeName === null)).toBe(true);
  });

  it('leaves a section out when its owner refuses, and marks a slow one as error', async () => {
    facade.marketplaceOperations = () => Promise.resolve(err({ code: 'access.denied' as const }));
    facade.marketplaceFinance = () => new Promise(() => undefined);
    const out = await build([ORDERS, MONEY], 20).execute(admin, { period: '7d' });
    expect(out.ok && out.value.operations).toBeNull();
    expect(out.ok && out.value.finance).toEqual({ status: 'error' });
  });

  it('marks a slow discount cost as error and keeps finance', async () => {
    facade.marketplaceDiscountCost = () => new Promise(() => undefined);
    const out = await build([MONEY, PROMO_MANAGE], 20).execute(admin, { period: '7d' });
    expect(out.ok && out.value.discountCost).toEqual({ status: 'error' });
    expect(out.ok && out.value.finance?.status).toBe('ok');
  });

  it('marks a section that throws as error and keeps the other', async () => {
    facade.marketplaceOperations = () => Promise.reject(new TypeError('boom'));
    const out = await build([ORDERS, MONEY]).execute(admin, { period: '30d' });
    expect(out.ok && out.value.operations).toEqual({ status: 'error' });
    expect(out.ok && out.value.finance?.status).toBe('ok');
  });

  it('writes money as minor-unit strings and keeps null for an average with no order', async () => {
    const out = await build([MONEY]).execute(admin, { period: '7d' });
    if (!out.ok) throw new Error('expected ok');
    const body = adminKpisBody(out.value);
    expect(body.periodId).toBe('7d');
    expect(body.finance?.kpis?.current.gmvWithTax).toEqual({
      amountMinor: '123456',
      currency: 'AUD',
    });
    expect(body.finance?.kpis?.current.averageOrderWithTax).toBeNull();
    expect(body.finance?.kpis?.series[0]).toMatchObject({ gmvWithTax: '5' });
    expect(body.operations).toBeNull();
    expect(() => JSON.stringify(body)).not.toThrow();
  });

  it('writes net revenue with its components, a partial total with no amount, and a labelled take rate', async () => {
    const out = await build([MONEY]).execute(admin, { period: '7d' });
    if (!out.ok) throw new Error('expected ok');
    const net = adminKpisBody(out.value).finance?.kpis?.net;
    expect(net?.readiness).toMatchObject({ ready: true, reason: 'ready' });
    expect(net?.current?.components.commission).toEqual({
      status: 'available',
      amount: { amountMinor: '14816', currency: 'AUD' },
    });
    expect(net?.current?.components.fleetFees).toEqual({
      status: 'not-available',
      reason: 'not-recorded',
    });
    expect(net?.current?.total).toEqual({
      status: 'partial',
      missing: ['deliveryMargin', 'platformFundedDiscounts', 'platformFundedCashback', 'fleetFees'],
    });
    expect(net?.takeRate.current).toMatchObject({
      status: 'partial',
      rateBp: 1320,
      basis: ['commission'],
    });
    expect(net?.takeRate.previous).toEqual({ status: 'no-sales' });
    expect(net?.previous).toBeNull();
  });
  it('refuses a seller session and a viewer of another population, and asks nobody', async () => {
    const seller = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: id(0xb1),
        sessionId: id(0x10b1),
        sellerId: id(0x5e11),
      }),
    );
    const out = await build([ORDERS, MONEY]).execute(seller, { period: '7d' });
    expect(out.ok).toBe(false);
    expect(asked).toEqual([]);
  });
});
