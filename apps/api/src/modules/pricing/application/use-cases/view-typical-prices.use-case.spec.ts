import { Logger } from '@nestjs/common';
import { money, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  FakeOfferSellUnits,
  FakeUnitOfWork,
  InMemoryFirstPriceReference,
  InMemoryPriceSeries,
  InMemoryWriteRateCounters,
} from '../../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { priceAmount } from '../../domain/price-amount';
import { PriceSeries } from '../../domain/price-series';
import { ConfigPricingPolicyProvider } from '../../infrastructure/config-pricing-policy-provider';
import { ViewTypicalPrices } from './view-typical-prices.use-case';

// `pricing.view-typical-prices` in memory on both Market fixtures: a range from the R4 reference
// (median of other live Offers, one vote per business, at least `referenceSellers` businesses),
// never the exact median, no reason when absent, own Offers never count, per-account read cap.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const policies = new ConfigPricingPolicyProvider(markets);
const CURRENCY = { AU: 'AUD', ZZ: 'JPY' } as const;

describe.each(['AU', 'ZZ'] as const)('pricing.view-typical-prices in market %s', (code) => {
  const currency = CURRENCY[code];
  const market: MarketContext = testMarketContext(code, 'default');
  const T0 = Temporal.Instant.from('2026-11-25T10:00:00Z');
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  function setup() {
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const unitOfWork = new FakeUnitOfWork();
    const series = new InMemoryPriceSeries();
    const offers = new FakeOfferSellUnits();
    const reference = new InMemoryFirstPriceReference(series);
    const counters = new InMemoryWriteRateCounters();
    const useCase = new ViewTypicalPrices(gate, {
      unitOfWork,
      counters,
      offers,
      clock,
      reference: reference.ports,
    });
    const productId = ids.next<'Product'>();
    const variantId = ids.next<'Variant'>();
    const policy = policies.forMarket(market);

    const seller = (opts: { price?: bigint; live?: boolean; eligible?: boolean } = {}) => {
      const sellerId = ids.next<'Seller'>();
      const accountId = ids.next<'Account'>();
      const offerId = ids.next<'Offer'>();
      offers.put(market, offerId, {
        sellerId,
        productId,
        deleted: false,
        priceableVariantIds: [variantId],
        liveVariantIds: opts.live === false ? [] : [variantId],
      });
      if (opts.eligible !== false) reference.eligible.add(sellerId);
      if (opts.price !== undefined) {
        const s = PriceSeries.create({
          id: ids.next<'PriceSeries'>(),
          marketId: market.marketId,
          offerId,
          variantId,
          productId,
          sellerId,
          currency,
          now: T0.subtract({ hours: 1 }),
        });
        const amount = priceAmount(money(opts.price, currency), policy);
        if (!amount.ok) throw new Error('fixture amount');
        const set = s.setRegularPrice({
          recordId: ids.next<'RegularPriceRecord'>(),
          amount: amount.value,
          submittedBy: accountId,
          taxInclusive: true,
          now: T0.subtract({ hours: 1 }),
          policy,
        });
        if (!set.ok) throw new Error('fixture price');
        series.rows.set(`${market.marketId}|${offerId}|${variantId}`, s.state);
      }
      const context: CallContext = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId,
          sessionId: ids.next<'Session'>(),
          sellerId,
        }),
      );
      return { sellerId, offerId, context, view: () => useCase.execute(context, { offerId }) };
    };
    return { reference, offers, counters, seller, variantId };
  }

  it('answers a range from three other businesses and never the exact median', async () => {
    const { seller } = setup();
    seller({ price: 1800n });
    seller({ price: 1790n });
    seller({ price: 1750n });
    const me = seller();
    const result = await me.view();
    if (!result.ok) throw new Error('expected ok');
    const range = result.value.variants[0]?.range;
    expect(range).not.toBeNull();
    expect(BigInt(range!.lowMinor) < 1790n && BigInt(range!.highMinor) > 1790n).toBe(true);
    expect(JSON.stringify(result.value)).not.toContain('1790');
    expect(Object.keys(result.value.variants[0]!).sort()).toEqual(['range', 'variantId']);
  });

  it('shows no range, and no reason, with fewer than three businesses', async () => {
    const { seller } = setup();
    seller({ price: 1800n });
    seller({ price: 1790n });
    const result = await seller().view();
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.variants[0]?.range).toBeNull();
  });

  it("counts one vote per business, ignores the seller's own Offers, non-live and ineligible ones", async () => {
    const { seller } = setup();
    seller({ price: 1800n });
    seller({ price: 1790n });
    seller({ price: 1000n, live: false });
    seller({ price: 1000n, eligible: false });
    const me = seller({ price: 5n });
    const result = await me.view();
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.variants[0]?.range).toBeNull();
  });

  it('shows no range when the reference cannot be read, as when there is none', async () => {
    const { seller, reference } = setup();
    seller({ price: 1800n });
    seller({ price: 1790n });
    seller({ price: 1750n });
    reference.businessesFail = new Error('sellers down');
    const result = await seller().view();
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.variants[0]?.range).toBeNull();
  });

  it("answers one 404 for an Offer that is not the seller's", async () => {
    const { seller, offers, counters, reference } = setup();
    const owner = seller();
    const other = seller();
    const result = await new ViewTypicalPrices(gate, {
      unitOfWork: new FakeUnitOfWork(),
      counters,
      offers,
      clock: new FixedClock(T0),
      reference: reference.ports,
    }).execute(other.context, { offerId: owner.offerId });
    expect(result).toEqual({ ok: false, error: { code: 'pricing.offer-not-found' } });
  });

  it('refuses a malformed Offer id', async () => {
    const { seller, offers, counters, reference } = setup();
    const me = seller();
    const result = await new ViewTypicalPrices(gate, {
      unitOfWork: new FakeUnitOfWork(),
      counters,
      offers,
      clock: new FixedClock(T0),
      reference: reference.ports,
    }).execute(me.context, { offerId: 'nope' });
    expect(result).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
  });

  it('caps reads per account at 30 a minute, apart from the price-write allowance', async () => {
    const { seller, counters } = setup();
    const me = seller();
    for (let i = 0; i < 30; i += 1) expect((await me.view()).ok).toBe(true);
    const refused = await me.view();
    expect(refused).toMatchObject({ ok: false, error: { code: 'request.throttled' } });
    if (!refused.ok && refused.error.code === 'request.throttled') {
      expect(refused.error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
    const kinds = [...counters.rows.keys()].map((k) => k.split('|')[1]);
    expect(kinds.every((k) => k?.startsWith('typical.'))).toBe(true);
  });
});
