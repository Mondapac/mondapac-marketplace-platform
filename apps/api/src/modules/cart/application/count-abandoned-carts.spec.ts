import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import {
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
import { CartReportingFacadeImplementation } from '../presentation/cart-reporting.facade';
import type { AbandonedCartTotalsReader } from './ports/abandoned-cart-totals';
import { CountAbandonedCarts } from './use-cases/count-abandoned-carts.use-case';

// The abandoned-cart count for reporting's nightly snapshot (dashboards v2, phase 2) on both Market
// fixtures: the system actor only, the instant passed to the reader unchanged in the caller's
// Market.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
const unitOfWork = {
  run: (_market: unknown, work: () => Promise<unknown>) => work(),
} as never;
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const AT = Temporal.Instant.from('2026-11-23T14:00:00Z');

describe.each(TEST_MARKETS)('cart.count-abandoned-carts in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const currency = markets.get(market.marketId).defaultCurrency;
  let asked: { market: MarketContext; at: Temporal.Instant }[];
  let answer: Awaited<ReturnType<AbandonedCartTotalsReader['totals']>>;
  const reader: AbandonedCartTotalsReader = {
    totals: (m, at) => {
      asked.push({ market: m, at });
      return Promise.resolve(answer);
    },
  };
  const facade = new CartReportingFacadeImplementation(
    new CountAbandonedCarts(gate, { unitOfWork, totals: reader }),
  );

  beforeEach(() => {
    asked = [];
    answer = { carts: 7, values: [{ amount: 12_345n, currency }] };
  });

  it('answers the count and the value per currency to the system actor', async () => {
    const result = await facade.abandonedCarts(testCallContext(market, 'system'), {
      changedAtOrBefore: AT,
    });
    expect(result).toEqual({ ok: true, value: answer });
    expect(asked).toEqual([{ market, at: AT }]);
  });

  it('refuses a person, even a platform admin, and a missing instant', async () => {
    const admin = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: id(0xa1),
        sessionId: id(0x10a1),
        sellerId: null,
      }),
    );
    const denied = await facade.abandonedCarts(admin, { changedAtOrBefore: AT });
    expect(denied.ok).toBe(false);
    const invalid = await facade.abandonedCarts(testCallContext(market, 'system'), {} as never);
    expect(invalid).toEqual({ ok: false, error: { code: 'validation.failed' } });
    expect(asked).toEqual([]);
  });
});
