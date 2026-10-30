import { err, money, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork, InMemoryPriceSeries } from '../../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { priceAmount } from '../../domain/price-amount';
import type { RegularPriceRecord } from '../../domain/price-series';
import { ConfigPricingPolicyProvider } from '../../infrastructure/config-pricing-policy-provider';
import { PricingFacadeImplementation } from '../../presentation/pricing.facade';
import { DaysAtPriceSystemQuery } from './days-at-price-system.use-case';
import { DaysAtPriceQuery } from './days-at-price.use-case';

// `pricing.days-at-price` in memory, on both Market fixtures: the window ends at the clock's now,
// the request is checked before any unit opens, and an unknown key answers null. The counting
// itself is domain/price-history.spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const policies = new ConfigPricingPolicyProvider(markets);
const NOW = Temporal.Instant.from('2026-10-28T10:00:00Z');

describe.each(['AU', 'ZZ'] as const)('pricing.days-at-price in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const currency = policies.forMarket(market).currency;
  const PRICE = 1_999n;

  function setup() {
    const clock = new FixedClock(NOW);
    const ids = new SequenceIdGenerator(clock);
    const series = new InMemoryPriceSeries();
    const unitOfWork = new FakeUnitOfWork();
    const deps = { unitOfWork, series, clock };
    const query = new DaysAtPriceQuery(gate, deps);
    const system = new DaysAtPriceSystemQuery(gate, deps);
    const buyer = testCallContext(market, 'anonymous', 'dp-0001-abcd');
    /** A series whose one regular price has been in force since `daysAgo` days before now. */
    const store = (where: MarketContext, daysAgo: number) => {
      const amount = priceAmount(money(PRICE, currency), policies.forMarket(market));
      if (!amount.ok) throw new Error('fixture amount');
      const since = NOW.subtract({ hours: daysAgo * 24 });
      const row: RegularPriceRecord = {
        id: ids.next<'RegularPriceRecord'>(),
        amount: amount.value,
        taxInclusive: true,
        status: 'ACCEPTED',
        submittedAt: since,
        submittedBy: ids.next<'Account'>(),
        effectiveFrom: since,
        effectiveTo: null,
        anchor: null,
        heldDirection: null,
        supersededBy: null,
        supersededAt: null,
        supersedeCause: null,
        decision: null,
      };
      const key = { offerId: ids.next<'Offer'>(), variantId: ids.next<'Variant'>() };
      series.rows.set(`${where.marketId}|${key.offerId}|${key.variantId}`, {
        id: ids.next<'PriceSeries'>(),
        marketId: where.marketId,
        offerId: key.offerId,
        variantId: key.variantId,
        productId: ids.next<'Product'>(),
        sellerId: ids.next<'Seller'>(),
        currency,
        createdAt: since,
        retiredAt: null,
        retireCause: null,
        version: 1,
        regular: [row],
        specials: [],
      });
      return key;
    };
    return { ids, query, system, buyer, store, unitOfWork };
  }

  const price = () => ({ amount: PRICE, currency });

  it('counts the days of the window ending now, in one read-only unit', async () => {
    const { query, buyer, store, unitOfWork } = setup();
    const key = store(market, 40);
    expect(await query.execute(buyer, { key, price: price(), windowDays: 90 })).toEqual(ok(40));
    expect(await query.execute(buyer, { key, price: price(), windowDays: 28 })).toEqual(ok(28));
    expect(
      await query.execute(buyer, { key, price: { amount: PRICE + 1n, currency }, windowDays: 90 }),
    ).toEqual(ok(0));
    expect(unitOfWork.units.every((unit) => unit.options.readOnly === true)).toBe(true);
  });

  it("answers null for an unknown key and for another Market's key alike", async () => {
    const { ids, query, buyer, store } = setup();
    const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
    const foreign = store(other, 40);
    const unknown = { offerId: ids.next<'Offer'>(), variantId: ids.next<'Variant'>() };
    const a = await query.execute(buyer, { key: unknown, price: price(), windowDays: 90 });
    const b = await query.execute(buyer, { key: foreign, price: price(), windowDays: 90 });
    expect(a).toEqual(ok(null));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it.each([
    ['a malformed key', { key: { offerId: 'x', variantId: 'y' } }, 'key'],
    ['no key', { key: null }, 'key'],
    ['a zero price', { price: { amount: 0n, currency: 'AUD' } }, 'price'],
    ['a number amount', { price: { amount: 1999, currency: 'AUD' } }, 'price'],
    ['a malformed currency', { price: { amount: 1n, currency: 'aud' } }, 'price'],
    ['a zero window', { windowDays: 0 }, 'windowDays'],
    ['a fractional window', { windowDays: 1.5 }, 'windowDays'],
    ['a window over the maximum', { windowDays: 367 }, 'windowDays'],
  ])('refuses %s before any unit opens', async (_name, patch, path) => {
    const { query, buyer, store, unitOfWork } = setup();
    const key = store(market, 40);
    const input = { key, price: price(), windowDays: 90, ...patch } as never;
    const result = await query.execute(buyer, input);
    expect(result).toEqual(err(expect.objectContaining({ code: 'validation.failed' })));
    expect(!result.ok && 'fields' in result.error && result.error.fields[0]?.path).toBe(path);
    expect(unitOfWork.units).toEqual([]);
  });

  it('accepts the longest window', async () => {
    const { query, buyer, store } = setup();
    const key = store(market, 400);
    expect(await query.execute(buyer, { key, price: price(), windowDays: 366 })).toEqual(ok(366));
  });

  it('is reached through the facade, the pair chosen by the actor', async () => {
    const { query, system, buyer, store } = setup();
    const key = store(market, 40);
    const facade = new PricingFacadeImplementation({
      daysAtPrice: query,
      daysAtPriceSystem: system,
    } as unknown as ConstructorParameters<typeof PricingFacadeImplementation>[0]);
    const amount = money(PRICE, currency);
    expect(await facade.daysAtPrice(buyer, key, amount, 90)).toEqual(ok(40));
    expect(await facade.daysAtPrice(testCallContext(market, 'system'), key, amount, 90)).toEqual(
      ok(40),
    );
  });

  it('keeps the pair apart: the system case refuses a request actor', async () => {
    const { system, buyer, store } = setup();
    const key: { offerId: Id<'Offer'>; variantId: Id<'Variant'> } = store(market, 40);
    const result = await system.execute(buyer, { key, price: price(), windowDays: 90 });
    expect(result.ok).toBe(false);
  });
});
