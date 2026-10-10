import { money, Temporal } from '@mondapac/shared-kernel';
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
import { priceKeyOf } from '../../contracts/pricing.facade';
import { priceAmount } from '../../domain/price-amount';
import type { PriceSeriesState, RegularPriceRecord } from '../../domain/price-series';
import { ConfigPricingPolicyProvider } from '../../infrastructure/config-pricing-policy-provider';
import { EffectivePricesSystemQuery } from './effective-prices-system.use-case';
import { EffectivePricesQuery } from './effective-prices.use-case';

// `pricing.effective-prices` in memory, on both Market fixtures: the price in force, and every
// case that answers "no valid price" (absent from the map).

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const policies = new ConfigPricingPolicyProvider(markets);
const T0 = Temporal.Instant.from('2026-10-09T10:00:00Z');

describe.each(['AU', 'ZZ'] as const)('pricing.effective-prices in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const currency = policies.forMarket(market).currency;

  function setup() {
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const series = new InMemoryPriceSeries();
    const deps = { unitOfWork: new FakeUnitOfWork(), series, clock };
    const query = new EffectivePricesQuery(gate, deps);
    const system = new EffectivePricesSystemQuery(gate, deps);
    const buyer = testCallContext(market, 'anonymous', 'ep-0001-abcd');
    const store = (
      offerId: Id<'Offer'>,
      variantId: Id<'Variant'>,
      patch: Partial<PriceSeriesState> = {},
      record: Partial<RegularPriceRecord> = {},
    ) => {
      const amount = priceAmount(money(1_999n, currency), policies.forMarket(market));
      if (!amount.ok) throw new Error('fixture amount');
      const row: RegularPriceRecord = {
        id: ids.next<'RegularPriceRecord'>(),
        amount: amount.value,
        taxInclusive: true,
        status: 'ACCEPTED',
        submittedAt: T0.subtract({ hours: 2 }),
        submittedBy: ids.next<'Account'>(),
        effectiveFrom: T0.subtract({ hours: 1 }),
        effectiveTo: null,
        anchor: null,
        heldDirection: null,
        supersededBy: null,
        supersededAt: null,
        supersedeCause: null,
        decision: null,
        ...record,
      };
      series.rows.set(`${market.marketId}|${offerId}|${variantId}`, {
        id: ids.next<'PriceSeries'>(),
        marketId: market.marketId,
        offerId,
        variantId,
        productId: ids.next<'Product'>(),
        sellerId: ids.next<'Seller'>(),
        currency,
        createdAt: T0.subtract({ hours: 2 }),
        retiredAt: null,
        retireCause: null,
        version: 1,
        regular: [row],
        ...patch,
      });
      return row;
    };
    return { ids, query, system, buyer, store, deps };
  }

  it('returns the price in force and leaves keys without one out', async () => {
    const { ids, query, buyer, store } = setup();
    const offer = ids.next<'Offer'>();
    const variant = ids.next<'Variant'>();
    const record = store(offer, variant);
    const unpriced = { offerId: ids.next<'Offer'>(), variantId: ids.next<'Variant'>() };

    const result = await query.execute(buyer, {
      keys: [{ offerId: offer, variantId: variant }, unpriced],
    });

    if (!result.ok) throw new Error('expected ok');
    expect([...result.value.keys()]).toEqual([priceKeyOf({ offerId: offer, variantId: variant })]);
    expect(result.value.get(`${offer}/${variant}`)).toEqual({
      price: money(1_999n, currency),
      taxInclusive: true,
      recordId: record.id,
    });
  });

  it('treats a retired series and a start in the future as no valid price', async () => {
    const { ids, query, buyer, store } = setup();
    const retired = { offerId: ids.next<'Offer'>(), variantId: ids.next<'Variant'>() };
    store(retired.offerId, retired.variantId, { retiredAt: T0, retireCause: 'offer-removed' });
    const future = { offerId: ids.next<'Offer'>(), variantId: ids.next<'Variant'>() };
    store(future.offerId, future.variantId, {}, { effectiveFrom: T0.add({ hours: 1 }) });

    const result = await query.execute(buyer, { keys: [retired, future] });

    if (!result.ok) throw new Error('expected ok');
    expect(result.value.size).toBe(0);
  });

  it('refuses a malformed key and more than 200 keys whole, before any read', async () => {
    const { ids, query, buyer, deps } = setup();
    const good = { offerId: ids.next<'Offer'>(), variantId: ids.next<'Variant'>() };

    const bad = await query.execute(buyer, { keys: [good, { offerId: 'x', variantId: 'y' }] });
    const many = await query.execute(buyer, { keys: Array.from({ length: 201 }, () => good) });

    expect(bad).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'keys', code: 'format' }] },
    });
    expect(many).toEqual({ ok: false, error: { code: 'batch.too-large' } });
    expect(deps.unitOfWork.units).toHaveLength(0);
  });

  it('answers the system actor through the pair, in a read-only unit', async () => {
    const { ids, system, store, deps } = setup();
    const offer = ids.next<'Offer'>();
    const variant = ids.next<'Variant'>();
    store(offer, variant);

    const result = await system.execute(testCallContext(market, 'system', 'ep-0002-abcd'), {
      keys: [{ offerId: offer, variantId: variant }],
    });

    expect(result.ok && result.value.size).toBe(1);
    expect(deps.unitOfWork.units[0]?.options).toEqual({ readOnly: true });
  });
});
