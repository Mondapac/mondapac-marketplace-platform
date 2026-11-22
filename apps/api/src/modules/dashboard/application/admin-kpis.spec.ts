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
  FinanceAnswer,
  OperationsAnswer,
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

const CATALOG_VIEW = 'catalog.product.view' as PermissionKey;
const SELLERS_VIEW = 'sellers.seller.view' as PermissionKey;
const queueCount = (count: number) =>
  ok({ count, overdue: 0, oldestAt: null }) as ReturnType<
    typeof ok<{ count: number; overdue: number; oldestAt: null }>
  >;
const queues = (
  overrides: {
    claims?: () => Promise<unknown>;
    unhealthy?: () => Promise<unknown>;
  } = {},
): AdminKpisDependencies['queues'] =>
  ({
    catalog: {
      claimsWithoutCertificate: overrides.claims ?? (() => Promise.resolve(queueCount(2))),
    },
    sellers: {
      unhealthySellers: overrides.unhealthy ?? (() => Promise.resolve(queueCount(14))),
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
    facade = {
      marketplaceOperations: () => {
        asked.push('operations');
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
    };
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
    expect(asked).toEqual(['operations']);
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

  it('answers the health counts the viewer may see, each under its own key', async () => {
    const both = await build([CATALOG_VIEW, SELLERS_VIEW]).execute(admin, { period: '7d' });
    expect(both.ok && both.value.health).toEqual({
      uncertifiedListings: { status: 'ok', count: 2 },
      sellersAtRisk: { status: 'ok', count: 14 },
    });
    const one = await build([SELLERS_VIEW]).execute(admin, { period: '7d' });
    expect(one.ok && one.value.health).toEqual({
      uncertifiedListings: null,
      sellersAtRisk: { status: 'ok', count: 14 },
    });
    const none = await build([ORDERS, MONEY]).execute(admin, { period: '7d' });
    expect(none.ok && none.value.health).toBeNull();
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
      uncertifiedListings: { status: 'error' },
      sellersAtRisk: { status: 'error' },
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
