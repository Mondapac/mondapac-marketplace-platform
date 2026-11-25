import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
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
  InMemoryPriceSeries,
  InMemoryRefusalThrottles,
  InMemoryWriteRateCounters,
  RecordingAuditWriter,
  RecordingOutbox,
} from '../../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { ConfigPricingPolicyProvider } from '../../infrastructure/config-pricing-policy-provider';
import { SetRegularPrice } from './set-regular-price.use-case';
import { ViewOfferPrices } from './view-offer-prices.use-case';
import { MAX_LIST_OFFERS, ViewOffersPrices } from './view-offers-prices.use-case';

// `pricing.view-offers-prices` (Offer page PR 8) in memory on both Market fixtures: each own Offer
// is answered exactly as the one-Offer read answers it, and nothing else is.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const policies = new ConfigPricingPolicyProvider(markets);

const FIXTURES = {
  AU: { currency: 'AUD', a: 1_790n, b: 950n },
  ZZ: { currency: 'JPY', a: 1_800n, b: 900n },
} as const;

describe.each(['AU', 'ZZ'] as const)('pricing.view-offers-prices in market %s', (code) => {
  const fixture = FIXTURES[code];
  const market: MarketContext = testMarketContext(code, 'default');
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  function setup() {
    const clock = new FixedClock(Temporal.Instant.from('2026-11-25T10:00:00Z'));
    const ids = new SequenceIdGenerator(clock);
    const unitOfWork = new FakeUnitOfWork();
    const series = new InMemoryPriceSeries();
    const offers = new FakeOfferSellUnits();
    const write = new SetRegularPrice(gate, {
      unitOfWork,
      series,
      throttles: new InMemoryRefusalThrottles(),
      counters: new InMemoryWriteRateCounters(),
      offers,
      policies,
      audit: new RecordingAuditWriter(),
      outbox: new RecordingOutbox(),
      clock,
      ids,
    });
    const many = new ViewOffersPrices(gate, { unitOfWork, series, offers, policies, clock });
    const one = new ViewOfferPrices(gate, { unitOfWork, series, offers, policies, clock });
    const contextOf = (seller: Id<'Seller'>): CallContext =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: seller,
        }),
      );
    const sellerId = ids.next<'Seller'>();
    const offer = (seller: Id<'Seller'>, variants: number, deleted = false) => {
      const offerId = ids.next<'Offer'>();
      const variantIds = Array.from({ length: variants }, () => ids.next<'Variant'>());
      offers.put(market, offerId, {
        sellerId: seller,
        productId: ids.next<'Product'>(),
        deleted,
        priceableVariantIds: variantIds,
      });
      return { offerId, variantIds };
    };
    const price = (
      seller: Id<'Seller'>,
      offerId: Id<'Offer'>,
      variantId: Id<'Variant'>,
      amount: bigint,
    ) =>
      write.execute(contextOf(seller), {
        offerId,
        variantId,
        price: { amount: amount.toString(), currency: fixture.currency },
        expectedVersion: null,
      });
    return { ids, many, one, contextOf, sellerId, offer, price };
  }

  it('answers each own Offer as the one-Offer read does, in the asked order', async () => {
    const { many, one, contextOf, sellerId, offer, price } = setup();
    const single = offer(sellerId, 1);
    const sized = offer(sellerId, 2);
    expect((await price(sellerId, single.offerId, single.variantIds[0]!, fixture.a)).ok).toBe(true);
    expect((await price(sellerId, sized.offerId, sized.variantIds[1]!, fixture.b)).ok).toBe(true);
    const context = contextOf(sellerId);

    const result = await many.execute(context, {
      offerIds: `${sized.offerId},${single.offerId}`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.currency).toBe(fixture.currency);
    expect(result.value.offers.map((item) => item.offerId)).toEqual([
      sized.offerId,
      single.offerId,
    ]);
    for (const item of result.value.offers) {
      const alone = await one.execute(context, { offerId: item.offerId });
      expect(alone.ok && alone.value.variants).toEqual(item.variants);
    }
    expect(result.value.offers[1]?.variants[0]?.inForce?.amount).toBe(fixture.a.toString());
  });

  it("leaves out another seller's, a deleted and an unknown Offer without telling them apart", async () => {
    const { ids, many, contextOf, sellerId, offer } = setup();
    const mine = offer(sellerId, 1);
    const theirs = offer(ids.next<'Seller'>(), 1);
    const gone = offer(sellerId, 1, true);
    const unknown = ids.next<'Offer'>();

    const result = await many.execute(contextOf(sellerId), {
      offerIds: [theirs.offerId, mine.offerId, gone.offerId, unknown].join(','),
    });

    expect(result.ok && result.value.offers.map((item) => item.offerId)).toEqual([mine.offerId]);
  });

  it.each([
    ['nothing', undefined],
    ['an empty list', ''],
    ['a non-UUID', 'not-a-uuid'],
    ['a number', 7],
  ])('refuses %s as offerIds', async (_name, offerIds) => {
    const { many, contextOf, sellerId } = setup();

    const result = await many.execute(contextOf(sellerId), { offerIds });

    expect(result).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'offerIds', code: 'format' }] },
    });
  });

  it('refuses a repeated id and more than the largest list page', async () => {
    const { ids, many, contextOf, sellerId, offer } = setup();
    const mine = offer(sellerId, 1);
    const tooMany = Array.from({ length: MAX_LIST_OFFERS + 1 }, () => ids.next<'Offer'>());

    const repeated = await many.execute(contextOf(sellerId), {
      offerIds: `${mine.offerId},${mine.offerId}`,
    });
    const long = await many.execute(contextOf(sellerId), { offerIds: tooMany.join(',') });

    expect(repeated.ok).toBe(false);
    expect(long.ok).toBe(false);
  });

  it('takes exactly the largest list page', async () => {
    const { ids, many, contextOf, sellerId } = setup();
    const page = Array.from({ length: MAX_LIST_OFFERS }, () => ids.next<'Offer'>());

    const result = await many.execute(contextOf(sellerId), { offerIds: page.join(',') });

    expect(result).toEqual({ ok: true, value: { currency: fixture.currency, offers: [] } });
  });

  it('refuses an actor that is not a seller', async () => {
    const { ids, many, offer, sellerId } = setup();
    const mine = offer(sellerId, 1);
    const admin = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        sellerId: null,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
      }),
    );

    const result = await many.execute(admin, { offerIds: mine.offerId });

    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
  });
});
