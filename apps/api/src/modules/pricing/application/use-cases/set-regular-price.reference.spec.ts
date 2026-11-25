import { Logger } from '@nestjs/common';
import { money, Temporal } from '@mondapac/shared-kernel';
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
import { ApprovePriceHold } from './approve-price-hold.use-case';
import { RejectPriceHold } from './reject-price-hold.use-case';
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
    const common = { unitOfWork, series, audit, outbox, clock };
    const approve = new ApprovePriceHold(gate, { ...common, policies });
    const reject = new RejectPriceHold(gate, common);
    const admin = (): CallContext =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: null,
        }),
      );
    const productId = ids.next<'Product'>();
    const variantId = ids.next<'Variant'>();
    const policy = policies.forMarket(market);

    /** A seller with one Offer on the Variant, priced (or not) an hour ago. */
    const seller = (
      opts: {
        price?: bigint;
        live?: boolean;
        eligible?: boolean;
        /** Another Offer of this same seller (one business, several Offers). */
        as?: { sellerId: Id<'Seller'>; accountId: Id<'Account'> };
      } = {},
    ) => {
      const sellerId = opts.as?.sellerId ?? ids.next<'Seller'>();
      const accountId = opts.as?.accountId ?? ids.next<'Account'>();
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
      return { sellerId, accountId, offerId, context, price };
    };
    return {
      clock,
      series,
      offers,
      audit,
      outbox,
      reference,
      unitOfWork,
      seller,
      variantId,
      approve,
      reject,
      admin,
    };
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
    // Catalog's post-publication review list hears of it, in the unit of the write: ids and the
    // reason only, keyed on the first-price record.
    const flagged = t.outbox.events.filter(
      (e) => e.type === 'pricing.offer-post-review-flagged.v1',
    );
    expect(flagged).toEqual([
      expect.objectContaining({
        aggregateId: output.recordId,
        aggregateVersion: 1,
        payload: {
          offerId: newcomer.offerId,
          productId: t.reference.checks[0]!.productId,
          sellerId: newcomer.sellerId,
          recordId: output.recordId,
          reason: 'no-reference',
        },
      }),
    ]);
  });

  it('accepts a first price within ±50% of the median of three businesses', async () => {
    const t = setup();
    for (const price of [900n, 1_000n, 1_200n]) t.seller({ price });
    const newcomer = t.seller();

    const output = valueOf(await newcomer.price(1_500n));

    expect(output.status).toBe('accepted');
    expect(t.outbox.events.map((e) => e.type)).not.toContain(
      'pricing.offer-post-review-flagged.v1',
    );
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
    expect(
      t.outbox.events
        .filter((e) => e.type === 'pricing.offer-post-review-flagged.v1')
        .map((e) => (e.payload as { reason: string }).reason),
    ).toEqual(['reference-unavailable']);
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

    // The re-check outside the band flags the early Offer, as version 2 of its record.
    expect(
      t.outbox.events
        .filter((e) => e.type === 'pricing.offer-post-review-flagged.v1')
        .map((e) => [e.aggregateId, e.aggregateVersion, (e.payload as { reason: string }).reason]),
    ).toEqual([
      [earlyOutput.recordId, 1, 'no-reference'],
      [earlyOutput.recordId, 2, 'recheck-outside'],
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
  it('approves a first price held against the median: it takes effect, audited with the median and no anchor', async () => {
    const t = setup();
    for (const price of [900n, 1_000n, 1_200n]) t.seller({ price });
    const newcomer = t.seller();
    const held = valueOf(await newcomer.price(1_501n));
    t.clock.set(T0.add({ minutes: 5 }));

    const approved = valueOf(await t.approve.execute(t.admin(), { recordId: held.recordId! }));

    expect(approved).toMatchObject({ outcome: 'approved', effectiveFrom: T0.add({ minutes: 5 }) });
    const record = t.series.stored(market, { offerId: newcomer.offerId, variantId: t.variantId })!
      .regular[0]!;
    expect(record).toMatchObject({ status: 'APPROVED', anchor: null });
    const row = t.audit.rows.find((r) => r.action === 'pricing.price-hold.approved');
    expect(row?.after).toMatchObject({
      referenceAmount: { amount: 1_000n, currency },
      amount: { amount: 1_501n, currency },
    });
    expect(row?.after).not.toHaveProperty('anchorRecordId', expect.anything());
    // It is no longer a first price: the next write is measured by the jump rule, not again by R4.
    t.clock.set(T0.add({ minutes: 6 }));
    valueOf(await newcomer.price(1_550n, approved.seriesVersion));
    expect(t.reference.checks).toHaveLength(1);
  });

  it('measures a resubmission again after an admin rejects a first price held against the median', async () => {
    const t = setup();
    for (const price of [900n, 1_000n, 1_200n]) t.seller({ price });
    const newcomer = t.seller();
    const held = valueOf(await newcomer.price(5_000n));
    t.clock.set(T0.add({ minutes: 5 }));
    const rejected = valueOf(
      await t.reject.execute(t.admin(), {
        recordId: held.recordId!,
        reasonCode: 'price-implausible',
      }),
    );
    t.clock.set(T0.add({ minutes: 6 }));

    const again = valueOf(await newcomer.price(1_100n, rejected.seriesVersion));

    expect(again.status).toBe('accepted');
    expect(t.reference.checks.map((c) => c.outcome)).toEqual(['outside', 'within']);
  });

  it('re-checks earlier prices in the same write that forms the median (default of 3 businesses)', async () => {
    const t = setup();
    const early = t.seller();
    valueOf(await early.price(5_000n)); // alone: no reference
    for (const price of [1_000n, 1_100n]) t.seller({ price });
    t.clock.set(T0.add({ minutes: 1 }));

    // The newcomer sees 3 businesses (early included) and is measured; its accepted price is the
    // third business early's own reference needed (1000, 1050, 1100 without early: 1050).
    valueOf(await t.seller().price(1_050n));

    const earlyCheck = t.reference.checks.find((c) => c.sellerId === early.sellerId)!;
    expect(earlyCheck).toMatchObject({
      postReviewReason: 'recheck-outside',
      recheck: { outcome: 'outside', referenceAmountMinor: 1_050n, amountMinor: 5_000n },
    });
  });

  it('treats a settings failure or invalid settings as reference unavailable, never as within', async () => {
    const t = setup();
    for (const price of [900n, 1_000n, 1_200n]) t.seller({ price });
    t.reference.settingsFail = new Error('settings down');
    expect(valueOf(await t.seller().price(90_000n)).status).toBe('accepted');
    t.reference.settingsFail = null;
    t.reference.current = { referenceSellers: 0, priceBandPercent: 50 };
    expect(valueOf(await t.seller().price(90_000n)).status).toBe('accepted');
    expect(t.reference.checks.map((c) => [c.outcome, c.postReviewReason])).toEqual([
      ['reference-unavailable', 'reference-unavailable'],
      ['reference-unavailable', 'reference-unavailable'],
    ]);
  });

  it('treats a catalog failure as reference unavailable', async () => {
    const t = setup();
    for (const price of [900n, 1_000n, 1_200n]) t.seller({ price });
    const newcomer = t.seller();
    // The Offer lookup of the write itself succeeds; the reference read (the second call) fails.
    const sellUnitsOf = t.offers.sellUnitsOf.bind(t.offers);
    let calls = 0;
    jest.spyOn(t.offers, 'sellUnitsOf').mockImplementation((context, ids) => {
      calls += 1;
      return calls === 1 ? sellUnitsOf(context, ids) : Promise.reject(new Error('catalog down'));
    });
    expect(valueOf(await newcomer.price(90_000n)).status).toBe('accepted');
    expect(t.reference.checks[0]).toMatchObject({ outcome: 'reference-unavailable' });
  });

  it("never counts the seller's own other Offers on the Variant: one business, however many Offers", async () => {
    const t = setup();
    t.seller({ price: 1_000n });
    t.seller({ price: 1_000n });
    const newcomer = t.seller();
    // The newcomer already sells the Variant on two other Offers: still only 2 other businesses.
    t.seller({ price: 1_000n, as: newcomer });
    t.seller({ price: 1_000n, as: newcomer });

    valueOf(await newcomer.price(9_000n));
    expect(t.reference.checks[0]).toMatchObject({ outcome: 'no-reference', businesses: 2 });
  });
});
