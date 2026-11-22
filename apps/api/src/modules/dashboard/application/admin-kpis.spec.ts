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
import type { FinanceAnswer, OperationsAnswer, ReportingKpiFacade } from '../../reporting';
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

const operations = { period: { id: '7d' } } as unknown as OperationsAnswer;
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
    };
  });

  it('asks only the sections whose keys the viewer holds', async () => {
    const out = await build([MONEY]).execute(admin, { period: '7d' });
    expect(asked).toEqual(['finance']);
    expect(out.ok && out.value.operations).toBeNull();
    expect(out.ok && out.value.finance?.status).toBe('ok');
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
