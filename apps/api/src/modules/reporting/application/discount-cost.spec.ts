import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
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
import type { DiscountCostTotals, PromotionsReportingFacade } from '../../promotions';
import type { DiscountTotals } from '../domain/discount-cost';
import { windowOf, type InstantWindow } from '../domain/period';
import { FacadeDiscountSources } from '../infrastructure/facade-discount-sources';
import { RegistryMarketZone } from '../infrastructure/registry-market-zone';
import type { DiscountSources } from './ports/discount-sources';
import { ViewMarketplaceDiscountCost } from './use-cases/view-marketplace-discount-cost.use-case';

// The discount cost (dashboards v2, phase 2) on both Market fixtures: the read asks promotions for
// the Market days of the period and of the period before (instants in the Market's zone, never
// UTC days), in the Market's currency, under the caller's own context; a platform admin only; a
// refusal of the key passes through and any other failure is unavailable, never a zero cost.

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

const totals = (orders: number, platform: bigint, seller: bigint): DiscountTotals => ({
  kept: { orders, amount: platform + seller, platformShare: platform, sellerShare: seller },
  byKind: [
    {
      kind: 'promotion',
      uses: orders,
      amount: platform + seller,
      platformShare: platform,
      sellerShare: seller,
    },
    { kind: 'first-order', uses: 0, amount: 0n, platformShare: 0n, sellerShare: 0n },
    { kind: 'free-shipping', uses: 0, amount: 0n, platformShare: 0n, sellerShare: 0n },
  ],
  released: { orders: 0, amount: 0n, platformShare: 0n, sellerShare: 0n },
});

describe.each(TEST_MARKETS)('the discount cost in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const zone = new RegistryMarketZone(markets);
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
  const admin = person('admin');

  let asked: { context: CallContext; currency: string; window: InstantWindow }[];
  let answers: DiscountTotals[];
  let sources: DiscountSources;
  const useCase = () =>
    new ViewMarketplaceDiscountCost(gate, { sources, zone, clock: new FixedClock(NOW) });

  beforeEach(() => {
    asked = [];
    answers = [totals(12, 3_000n, 9_000n), totals(10, 2_000n, 18_000n)];
    sources = {
      totalsOf: (context, currency, window) => {
        asked.push({ context, currency, window });
        return Promise.resolve(ok(answers[asked.length - 1]!));
      },
    };
  });

  it('asks the Market days of the period and the period before, in the Market currency, as the caller', async () => {
    const out = await useCase().execute(admin, { period: '7d' });
    if (!out.ok) throw new Error('expected an answer');
    const tz = zone.zoneOf(market);
    expect(asked.map((ask) => ask.window)).toEqual([
      windowOf(out.value.period.current, tz),
      windowOf(out.value.period.previous, tz),
    ]);
    expect(asked.every((ask) => ask.currency === zone.currencyOf(market))).toBe(true);
    expect(asked.every((ask) => ask.context === admin)).toBe(true);
    expect(out.value.currency).toBe(zone.currencyOf(market));
    expect(out.value.cost).toMatchObject({
      status: 'available',
      orders: 12,
      amount: 12_000n,
      platformShare: 3_000n,
      sellerShare: 9_000n,
      platformShareBp: 2500,
      previousAmount: 20_000n,
      change: { value: -4000, direction: 'down', state: 'ok' },
    });
  });

  it('refuses a seller and an acting-as admin before asking promotions', async () => {
    expect((await useCase().execute(person('seller'), { period: '7d' })).ok).toBe(false);
    const actingAs = Object.assign(
      Object.create(Object.getPrototypeOf(admin) as object) as object,
      admin,
      { actor: { ...admin.actor, actingAs: { sellerId: id(0x5e12) } } },
    ) as typeof admin;
    expect(await useCase().execute(actingAs, { period: '7d' })).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(asked).toEqual([]);
  });

  it('passes the owner’s refusal through and answers unavailable on a failure, never a zero cost', async () => {
    sources = { totalsOf: () => Promise.resolve(err({ code: 'access.denied' })) };
    expect(await useCase().execute(admin, { period: '7d' })).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    sources = { totalsOf: () => Promise.resolve(err({ code: 'access.unavailable' })) };
    expect(await useCase().execute(admin, { period: '7d' })).toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
    sources = { totalsOf: () => Promise.reject(new TypeError('down')) };
    expect(await useCase().execute(admin, { period: '7d' })).toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
  });

  it('refuses a custom range that ends after the Market today', async () => {
    const out = await useCase().execute(admin, {
      period: { from: '2026-11-20', to: '2026-12-30' } as never,
    });
    expect(out.ok).toBe(false);
    expect(asked).toEqual([]);
  });
});

describe('the promotions adapter of the discount cost', () => {
  const market = testMarketContext('AU', PLATFORM_TENANT_ID);
  const system = testCallContext(market, 'system');
  const window = {
    from: Temporal.Instant.from('2026-11-15T14:00:00Z'),
    to: Temporal.Instant.from('2026-11-22T14:00:00Z'),
  };
  const promotionsTotals: DiscountCostTotals = {
    kept: { orders: 3, amount: 900n, platformShare: 400n, sellerShare: 500n },
    byKind: [
      { kind: 'PROMOTION', uses: 2, amount: 600n, platformShare: 100n, sellerShare: 500n },
      { kind: 'FIRST_ORDER', uses: 1, amount: 300n, platformShare: 300n, sellerShare: 0n },
      { kind: 'FREE_SHIPPING', uses: 0, amount: 0n, platformShare: 0n, sellerShare: 0n },
    ],
    released: { orders: 0, amount: 0n, platformShare: 0n, sellerShare: 0n },
  };

  it('asks promotions with the caller’s context and names the kinds the dashboard way', async () => {
    const calls: unknown[] = [];
    const promotions: Pick<PromotionsReportingFacade, 'discountCost'> = {
      discountCost: (context, request) => {
        calls.push({ context, request });
        return Promise.resolve(ok(promotionsTotals));
      },
    };
    const out = await new FacadeDiscountSources(promotions).totalsOf(system, 'AUD', window);
    expect(calls).toEqual([{ context: system, request: { window, currency: 'AUD' } }]);
    expect(out.ok && out.value.byKind.map((row) => row.kind)).toEqual([
      'promotion',
      'first-order',
      'free-shipping',
    ]);
    expect(out.ok && out.value.kept).toEqual(promotionsTotals.kept);
  });

  it('keeps a refusal of the key and turns every other failure into unavailable', async () => {
    const answering = (error: { code: string }) =>
      new FacadeDiscountSources({
        discountCost: () => Promise.resolve(err(error) as never),
      }).totalsOf(system, 'AUD', window);
    expect(await answering({ code: 'access.denied' })).toEqual(err({ code: 'access.denied' }));
    for (const code of ['validation.failed', 'promotions.unavailable', 'access.unavailable']) {
      expect(await answering({ code })).toEqual(err({ code: 'access.unavailable' }));
    }
  });
});
