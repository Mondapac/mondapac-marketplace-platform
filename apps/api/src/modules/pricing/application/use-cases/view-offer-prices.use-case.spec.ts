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
import { SetSpecialPrice } from './set-special-price.use-case';
import { ViewOfferPrices } from './view-offer-prices.use-case';

// `pricing.view-offer-prices` in memory on both Market fixtures. Prices are seeded through the
// real write use case, so the read is checked against what the write stores.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const policies = new ConfigPricingPolicyProvider(markets);

const FIXTURES = {
  AU: { currency: 'AUD', base: 10_000n, held: 15_001n },
  ZZ: { currency: 'JPY', base: 1_000n, held: 1_251n },
} as const;

describe.each(['AU', 'ZZ'] as const)('pricing.view-offer-prices in market %s', (code) => {
  const fixture = FIXTURES[code];
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  const market: MarketContext = testMarketContext(code, 'default');

  function setup() {
    const clock = new FixedClock(Temporal.Instant.from('2026-10-08T10:00:00Z'));
    const ids = new SequenceIdGenerator(clock);
    const unitOfWork = new FakeUnitOfWork();
    const series = new InMemoryPriceSeries();
    const offers = new FakeOfferSellUnits();
    const write = new SetRegularPrice(gate, {
      unitOfWork,
      series,
      throttles: new InMemoryRefusalThrottles(),
      offers,
      policies,
      audit: new RecordingAuditWriter(),
      outbox: new RecordingOutbox(),
      clock,
      ids,
    });
    const view = new ViewOfferPrices(gate, { unitOfWork, series, offers, policies, clock });
    const sellerId = ids.next<'Seller'>();
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
    const offerId = ids.next<'Offer'>();
    const variantId = ids.next<'Variant'>();
    const otherVariantId = ids.next<'Variant'>();
    offers.put(market, offerId, {
      sellerId,
      productId: ids.next<'Product'>(),
      deleted: false,
      priceableVariantIds: [variantId, otherVariantId],
    });
    const price = (context: CallContext, amount: bigint, expectedVersion: number | null) =>
      write.execute(context, {
        offerId,
        variantId,
        price: { amount: amount.toString(), currency: fixture.currency },
        expectedVersion,
      });
    const special = new SetSpecialPrice(gate, {
      unitOfWork,
      series,
      throttles: new InMemoryRefusalThrottles(),
      offers,
      policies,
      audit: new RecordingAuditWriter(),
      outbox: new RecordingOutbox(),
      clock,
      ids,
    });
    return {
      clock,
      ids,
      offers,
      view,
      special,
      sellerId,
      contextOf,
      offerId,
      variantId,
      otherVariantId,
      price,
    };
  }

  it('shows every priceable variant, unpriced ones with a null version', async () => {
    const s = setup();
    const result = await s.view.execute(s.contextOf(s.sellerId), { offerId: s.offerId });
    expect(result.ok && result.value.currency).toBe(fixture.currency);
    expect(result.ok && result.value.variants).toHaveLength(2);
    expect(result.ok && result.value.variants.every((v) => v.seriesVersion === null)).toBe(true);
    expect(result.ok && result.value.variants.every((v) => v.inForce === null)).toBe(true);
  });

  it('shows the price in force and the version the next write needs', async () => {
    const s = setup();
    const context = s.contextOf(s.sellerId);
    const written = await s.price(context, fixture.base, null);
    if (!written.ok) throw new Error('seed failed');
    const result = await s.view.execute(context, { offerId: s.offerId });
    if (!result.ok) throw new Error('view failed');
    const row = result.value.variants.find((v) => v.variantId === s.variantId);
    expect(row?.seriesVersion).toBe(written.value.seriesVersion);
    expect(row?.currency).toBe(fixture.currency);
    expect(row?.inForce?.amount).toBe(fixture.base.toString());
    expect(row?.held).toBeNull();
    // The version it shows is the one the write accepts.
    expect((await s.price(context, fixture.base + 1n, row?.seriesVersion ?? null)).ok).toBe(true);
  });

  it('shows a held price next to the one in force', async () => {
    const s = setup();
    const context = s.contextOf(s.sellerId);
    const first = await s.price(context, fixture.base, null);
    if (!first.ok) throw new Error('seed failed');
    s.clock.set(s.clock.now().add({ minutes: 1 }));
    const held = await s.price(context, fixture.held, first.value.seriesVersion);
    if (!held.ok || held.value.status !== 'pending-review') throw new Error('not held');
    const result = await s.view.execute(context, { offerId: s.offerId });
    if (!result.ok) throw new Error('view failed');
    const row = result.value.variants.find((v) => v.variantId === s.variantId);
    expect(row?.inForce?.amount).toBe(fixture.base.toString());
    expect(row?.held?.amount).toBe(fixture.held.toString());
    expect(row?.held?.direction).toBe('up');
  });

  it('shows a running special, a scheduled one and one that ended', async () => {
    const s = setup();
    const context = s.contextOf(s.sellerId);
    const first = await s.price(context, fixture.base, null);
    if (!first.ok) throw new Error('seed failed');
    const hour = 3_600_000;
    const at = (ms: number) => s.clock.now().add({ milliseconds: ms }).toString();
    const amount = ((fixture.base * 9n) / 10n).toString();
    const row = async () => {
      const result = await s.view.execute(context, { offerId: s.offerId });
      if (!result.ok) throw new Error('view failed');
      return result.value.variants.find((v) => v.variantId === s.variantId);
    };
    const set = (startsAt: string | null, endsAt: string, expectedVersion: number) =>
      s.special.execute(context, {
        offerId: s.offerId,
        variantId: s.variantId,
        price: { amount, currency: fixture.currency },
        startsAt,
        endsAt,
        expectedVersion,
      });
    const running = await set(null, at(hour), first.value.seriesVersion);
    if (!running.ok) throw new Error('special failed');
    expect((await row())?.special).toMatchObject({ amount, state: 'running' });
    const later = await set(at(2 * hour), at(3 * hour), running.value.seriesVersion);
    if (!later.ok) throw new Error('scheduled special failed');
    expect((await row())?.special).toMatchObject({ amount, state: 'scheduled' });
    s.clock.set(s.clock.now().add({ milliseconds: 4 * hour }));
    expect((await row())?.special).toBeNull();
    expect((await row())?.heldSpecial).toBeNull();
  });

  it("answers another seller's Offer exactly as an unknown one", async () => {
    const s = setup();
    const foreign = await s.view.execute(s.contextOf(s.ids.next<'Seller'>()), {
      offerId: s.offerId,
    });
    const unknown = await s.view.execute(s.contextOf(s.sellerId), {
      offerId: s.ids.next<'Offer'>(),
    });
    expect(foreign).toEqual({ ok: false, error: { code: 'pricing.offer-not-found' } });
    expect(unknown).toEqual(foreign);
  });

  it('answers a deleted Offer as not found and a bad id as validation.failed', async () => {
    const s = setup();
    s.offers.put(market, s.offerId, {
      sellerId: s.sellerId,
      productId: s.ids.next<'Product'>(),
      deleted: true,
      priceableVariantIds: [],
    });
    const deleted = await s.view.execute(s.contextOf(s.sellerId), { offerId: s.offerId });
    expect(!deleted.ok && deleted.error.code).toBe('pricing.offer-not-found');
    const bad = await s.view.execute(s.contextOf(s.sellerId), { offerId: 'nope' });
    expect(!bad.ok && bad.error.code).toBe('validation.failed');
  });
});
