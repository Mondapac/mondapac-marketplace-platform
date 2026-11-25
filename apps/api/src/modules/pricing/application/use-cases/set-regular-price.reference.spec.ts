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
import { priceAmount } from '../../domain/price-amount';
import { PriceSeries } from '../../domain/price-series';
import { ConfigPricingPolicyProvider } from '../../infrastructure/config-pricing-policy-provider';
import { SetRegularPrice } from './set-regular-price.use-case';

// R4 of the risk-based Offer approval (ADR-0051; design catalog/offer-approval section 6) on
// `pricing.set-regular-price`, in memory, on both Market fixtures (AU in AUD, the synthetic ZZ in
// JPY with exponent 0 and a different jump policy). A seller's first price on a Variant is
// measured against the median of the regular prices of the other live Offers on it, from at least
// `referenceSellers` distinct eligible sellers (one approved seller = one business identifier).
// Fewer: the price is accepted and the Offer goes to 100% post-publication review; outside the
// band: the price waits in the price queue; when the reference first forms, earlier prices with no
// reference are re-checked.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const policies = new ConfigPricingPolicyProvider(markets);

const CURRENCY = { AU: 'AUD', ZZ: 'JPY' } as const;

describe.each(['AU', 'ZZ'] as const)('R4 first-price reference in market %s', (code) => {
  const currency = CURRENCY[code];
  const market: MarketContext = testMarketContext(code, 'default');
  const T0 = Temporal.Instant.from('2026-11-25T10:00:00Z');
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  function setup() {
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const unitOfWork = new FakeUnitOfWork();
    const series = new InMemoryPriceSeries();
    const offers = new FakeOfferSellUnits();
    const audit = new RecordingAuditWriter();
    const outbox = new RecordingOutbox();
    const reference = new InMemoryFirstPriceReference(series);
    const useCase = new SetRegularPrice(gate, {
      unitOfWork,
      series,
      throttles: new InMemoryRefusalThrottles(),
      counters: new InMemoryWriteRateCounters(),
      offers,
      policies,
      audit,
      outbox,
      clock,
      ids,
      reference: reference.ports,
    });
    const productId = ids.next<'Product'>();
    const variantId = ids.next<'Variant'>();
    const policy = policies.forMarket(market);

    /** A seller with one Offer on the Variant, priced (or not) an hour ago. */
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
      const price = (amount: bigint, expectedVersion: number | null = null) =>
        useCase.execute(context, {
          offerId,
          variantId,
          price: { amount: amount.toString(), currency },
          expectedVersion,
        });
      return { sellerId, offerId, context, price };
    };
    return { clock, series, offers, audit, outbox, reference, unitOfWork, seller, variantId };
  }

  const valueOf = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value;
  };

  const checkedRows = (audit: RecordingAuditWriter) =>
    audit.rows.filter((r) => r.action === 'pricing.first-price.checked');

  it('accepts a first price with fewer than 3 businesses and sends the Offer to post-publication review', async () => {
    const t = setup();
    t.seller({ price: 1_000n });
    t.seller({ price: 1_100n });
    const newcomer = t.seller();

    const output = valueOf(await newcomer.price(90_000n));

    expect(output.status).toBe('accepted');
    expect(t.reference.checks).toEqual([
      expect.objectContaining({
        recordId: output.recordId,
        sellerId: newcomer.sellerId,
        outcome: 'no-reference',
        referenceAmountMinor: null,
        businesses: 2,
        businessesNeeded: 3,
        bandPercent: 50,
        postReviewReason: 'no-reference',
      }),
    ]);
    expect(checkedRows(t.audit)).toEqual([
      expect.objectContaining({
        after: expect.objectContaining({
          outcome: 'no-reference',
          referenceAmount: null,
          businesses: 2,
          postReview: true,
          direction: null,
        }) as unknown,
      }),
    ]);
  });

  it('accepts a first price within ±50% of the median of three businesses', async () => {
    const t = setup();
    for (const price of [900n, 1_000n, 1_200n]) t.seller({ price });
    const newcomer = t.seller();

    const output = valueOf(await newcomer.price(1_500n));

    expect(output.status).toBe('accepted');
    const record = t.series.stored(market, { offerId: newcomer.offerId, variantId: t.variantId })!
      .regular[0]!;
    expect(record.reference).toEqual({
      amount: { amount: 1_000n, currency },
      businesses: 3,
      bandPercent: 50,
    });
    expect(t.reference.checks[0]).toMatchObject({
      outcome: 'within',
      referenceAmountMinor: 1_000n,
      postReviewReason: null,
    });
  });

  it('holds a first price more than 50% from the median in the price queue, with no anchor', async () => {
    const t = setup();
    for (const price of [900n, 1_000n, 1_200n]) t.seller({ price });
    const newcomer = t.seller();

    const output = valueOf(await newcomer.price(1_501n));

    expect(output).toMatchObject({ status: 'pending-review', effectiveFrom: null });
    const record = t.series.stored(market, { offerId: newcomer.offerId, variantId: t.variantId })!
      .regular[0]!;
    expect(record).toMatchObject({
      status: 'PENDING_REVIEW',
      anchor: null,
      heldDirection: 'up',
      reference: { amount: { amount: 1_000n, currency }, businesses: 3, bandPercent: 50 },
    });
    expect(t.audit.rows.map((r) => r.action)).toEqual(['pricing.first-price.checked']);
    expect(checkedRows(t.audit)[0]?.after).toMatchObject({
      outcome: 'outside',
      direction: 'up',
      postReview: false,
      referenceAmount: { amount: 1_000n, currency },
    });
    expect(t.outbox.events.map((e) => e.type)).toEqual(['pricing.price-hold-opened.v1']);
    // The queue shows it against the median.
    const page = await t.series.listPendingHolds(market, null, 10);
    expect(page[0]).toMatchObject({ basis: 'reference', anchorRecordId: null });
    expect(page[0]?.anchorAmount.amount).toBe(1_000n);
  });

  it('holds a typo far below the median (direction down)', async () => {
    const t = setup();
    for (const price of [1_140n, 1_150n, 1_160n]) t.seller({ price });
    const output = valueOf(await t.seller().price(115n));
    expect(output.status).toBe('pending-review');
    expect(t.reference.checks[0]).toMatchObject({ outcome: 'outside' });
  });

  it('never counts the seller itself, an Offer that is not live, or a seller that may not sell', async () => {
    const t = setup();
    t.seller({ price: 1_000n });
    t.seller({ price: 1_000n, live: false });
    t.seller({ price: 1_000n, eligible: false });
    const newcomer = t.seller();

    valueOf(await newcomer.price(9_000n));
    expect(t.reference.checks[0]).toMatchObject({ outcome: 'no-reference', businesses: 1 });
  });

  it('accepts and sends to review when the reference cannot be read (fail closed to review)', async () => {
    const t = setup();
    for (const price of [900n, 1_000n, 1_200n]) t.seller({ price });
    t.reference.businessesFail = new Error('sellers down');

    const output = valueOf(await t.seller().price(90_000n));

    expect(output.status).toBe('accepted');
    expect(t.reference.checks[0]).toMatchObject({
      outcome: 'reference-unavailable',
      postReviewReason: 'reference-unavailable',
      referenceAmountMinor: null,
    });
  });

  it('measures the next first price again after a held first price is rejected or replaced', async () => {
    const t = setup();
    for (const price of [900n, 1_000n, 1_200n]) t.seller({ price });
    const newcomer = t.seller();
    const held = valueOf(await newcomer.price(5_000n));
    expect(held.status).toBe('pending-review');

    t.clock.set(T0.add({ minutes: 1 }));
    const again = valueOf(await newcomer.price(4_000n, held.seriesVersion));

    expect(again.status).toBe('pending-review');
    expect(t.reference.checks.map((c) => c.outcome)).toEqual(['outside', 'outside']);
  });

  it('does not measure a later price against the reference (the jump rule measures it)', async () => {
    const t = setup();
    for (const price of [900n, 1_000n, 1_200n]) t.seller({ price });
    const newcomer = t.seller();
    const first = valueOf(await newcomer.price(1_000n));
    t.clock.set(T0.add({ minutes: 1 }));
    const eligibilityCalls = t.reference.eligibilityCalls.length;

    valueOf(await newcomer.price(1_100n, first.seriesVersion));

    expect(t.reference.checks).toHaveLength(1);
    expect(t.reference.eligibilityCalls).toHaveLength(eligibilityCalls);
  });

  it('re-checks earlier prices with no reference once the median forms', async () => {
    const t = setup();
    const early = t.seller(); // first on the Variant: no reference
    const earlyOutput = valueOf(await early.price(5_000n));
    expect(earlyOutput.status).toBe('accepted');
    t.reference.current = { referenceSellers: 2, priceBandPercent: 50 };
    for (const price of [1_000n, 1_100n]) t.seller({ price });
    t.clock.set(T0.add({ minutes: 1 }));

    // The next first price on the Variant finds a reference, and re-checks the early one against
    // the median of the others without it (1050): 5000 is outside.
    valueOf(await t.seller().price(1_050n));

    const earlyCheck = t.reference.checks.find((c) => c.sellerId === early.sellerId)!;
    expect(earlyCheck).toMatchObject({
      outcome: 'no-reference',
      postReviewReason: 'recheck-outside',
      recheck: {
        outcome: 'outside',
        referenceAmountMinor: 1_050n,
        amountMinor: 5_000n,
      },
    });
    expect(t.audit.rows.filter((r) => r.action === 'pricing.first-price.rechecked')).toEqual([
      expect.objectContaining({
        after: expect.objectContaining({ outcome: 'outside', offerId: early.offerId }) as unknown,
      }),
    ]);

    // Re-checked once only.
    t.clock.set(T0.add({ minutes: 2 }));
    valueOf(await t.seller().price(1_000n));
    expect(t.audit.rows.filter((r) => r.action === 'pricing.first-price.rechecked')).toHaveLength(
      1,
    );
  });

  it('keeps the band and the business count admin-editable', async () => {
    const t = setup();
    t.reference.current = { referenceSellers: 2, priceBandPercent: 10 };
    for (const price of [1_000n, 1_000n]) t.seller({ price });
    const output = valueOf(await t.seller().price(1_101n));
    expect(output.status).toBe('pending-review');
    expect(t.reference.checks[0]).toMatchObject({ businessesNeeded: 2, bandPercent: 10 });
  });
});
