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
import { InMemoryCostSeries } from '../../../../../test/support/pricing-cost-fakes';
import {
  FakeOfferSellUnits,
  FakeUnitOfWork,
  InMemoryRefusalThrottles,
  InMemoryWriteRateCounters,
  RecordingAuditWriter,
} from '../../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { revealCostMinor } from '../../domain/cost/cost-amount';
import { ConfigPricingPolicyProvider } from '../../infrastructure/config-pricing-policy-provider';
import { SetOfferCost, type SetOfferCostInput } from './set-offer-cost.use-case';
import { ViewOfferCosts } from './view-offer-costs.use-case';

// `pricing.set-cost` and `pricing.view-cost` in memory (pricing design 3.3, 5.2, 5.4, 6.5, 8;
// slice 3), on both Market fixtures: AU (AUD, exponent 2) and the synthetic ZZ (JPY, exponent 0).
// The gate admits every authenticated actor; the declarations are asserted here. The database
// behaviour (append-only rows, grants, the serializable creation) is in test/db/pricing-cost.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const policies = new ConfigPricingPolicyProvider(markets);

const FIXTURES = {
  AU: { currency: 'AUD', other: 'JPY', cost: 1_250n },
  ZZ: { currency: 'JPY', other: 'AUD', cost: 980n },
} as const;

/** A Cost value that would only appear in a leak: no test fixture uses it anywhere else. */
const CANARY = 7_777_123n;

describe.each(['AU', 'ZZ'] as const)('pricing Cost use cases in market %s', (code) => {
  const fixture = FIXTURES[code];
  const market: MarketContext = testMarketContext(code, 'default');
  const T0 = Temporal.Instant.from('2026-11-25T08:00:00Z');
  const logged: unknown[] = [];
  beforeEach(() => {
    logged.length = 0;
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
  });
  afterEach(() => jest.restoreAllMocks());

  function setup() {
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const unitOfWork = new FakeUnitOfWork();
    const costs = new InMemoryCostSeries();
    const throttles = new InMemoryRefusalThrottles();
    const counters = new InMemoryWriteRateCounters();
    const offers = new FakeOfferSellUnits();
    const audit = new RecordingAuditWriter();
    const setCost = new SetOfferCost(gate, {
      unitOfWork,
      costs,
      throttles,
      counters,
      offers,
      policies,
      audit,
      clock,
      ids,
    });
    const viewCosts = new ViewOfferCosts(gate, { unitOfWork, costs, offers, policies });
    const sellerId = ids.next<'Seller'>();
    const accountId = ids.next<'Account'>();
    const context = sellerContext(sellerId, accountId, ids);
    const offerId = ids.next<'Offer'>();
    const variantId = ids.next<'Variant'>();
    const otherVariantId = ids.next<'Variant'>();
    const productId = ids.next<'Product'>();
    offers.put(market, offerId, {
      sellerId,
      productId,
      deleted: false,
      priceableVariantIds: [variantId, otherVariantId],
    });
    const input = (amount: bigint | null, expectedVersion: number | null): SetOfferCostInput => ({
      offerId,
      variantId,
      cost: amount === null ? null : { amount: amount.toString(), currency: fixture.currency },
      expectedVersion,
    });
    return {
      ids,
      unitOfWork,
      costs,
      offers,
      audit,
      setCost,
      viewCosts,
      sellerId,
      accountId,
      context,
      offerId,
      variantId,
      otherVariantId,
      productId,
      input,
    };
  }

  function sellerContext(
    sellerId: Id<'Seller'>,
    accountId: Id<'Account'>,
    ids: SequenceIdGenerator,
  ): CallContext {
    return testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId,
      }),
    );
  }

  /**
   * The same context, marked as a Login as Seller session (the reserved `actingAs` field). No
   * session mints the marker yet (SEL-08), so today the gate refuses such an actor first; the
   * use case's own check (`isActingAsSession`, tested in acting-as.spec) is the second layer.
   * Either way nothing is read or written.
   */
  function actingAs(context: CallContext, admin: Id<'Account'>): CallContext {
    return {
      ...context,
      actor: { ...context.actor, actingAs: { adminAccountId: admin } } as never,
    };
  }

  const valueOf = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value;
  };

  it('declares the rules of design 5.2: view needs cost.view; set needs price.edit and cost.view (H1)', () => {
    expect(ViewOfferCosts.access).toEqual({
      name: 'pricing.view-cost',
      rule: { kind: 'permissions', allOf: ['pricing.cost.view'] },
      whenSellerNotApproved: 'deny',
    });
    expect(SetOfferCost.access).toEqual({
      name: 'pricing.set-cost',
      rule: { kind: 'permissions', allOf: ['pricing.price.edit', 'pricing.cost.view'] },
      whenSellerNotApproved: 'deny',
    });
  });

  describe('pricing.set-cost', () => {
    it('creates the series in a serializable unit, appends one record and one audit row without an amount', async () => {
      const t = setup();
      const output = valueOf(await t.setCost.execute(t.context, t.input(fixture.cost, null)));

      expect(output).toEqual({ status: 'recorded', seriesVersion: 1 });
      expect(t.unitOfWork.units.map((unit) => unit.options.isolation ?? 'default')).toEqual([
        'default', // the write allowance
        'default', // the write unit found no series
        'serializable', // the creating unit
      ]);
      const stored = t.costs.stored(market, t.offerId, t.variantId)!;
      expect(stored).toMatchObject({
        productId: t.productId,
        sellerId: t.sellerId,
        currency: fixture.currency,
        version: 1,
      });
      expect(revealCostMinor(stored.latest!.amount!)).toEqual({
        amount: fixture.cost,
        currency: fixture.currency,
      });
      expect(stored.latest!.submittedBy).toBe(t.accountId);
      expect(t.audit.rows.map((entry) => entry.action)).toEqual(['pricing.cost.set']);
      expect(JSON.stringify(t.audit.rows)).not.toContain(fixture.cost.toString());
    });

    it('appends a new record under the screen version; the same Cost again records nothing', async () => {
      const t = setup();
      valueOf(await t.setCost.execute(t.context, t.input(fixture.cost, null)));
      expect(valueOf(await t.setCost.execute(t.context, t.input(fixture.cost + 1n, 1)))).toEqual({
        status: 'recorded',
        seriesVersion: 2,
      });
      expect(valueOf(await t.setCost.execute(t.context, t.input(fixture.cost + 1n, 2)))).toEqual({
        status: 'unchanged',
        seriesVersion: 2,
      });
      expect(t.costs.records).toHaveLength(2);
      expect(t.audit.rows).toHaveLength(2);
    });

    it('clears with a "cleared" record and the pricing.cost.cleared row; clearing "none" writes nothing', async () => {
      const t = setup();
      expect(valueOf(await t.setCost.execute(t.context, t.input(null, null)))).toEqual({
        status: 'unchanged',
        seriesVersion: null,
      });
      expect(t.costs.records).toHaveLength(0);

      valueOf(await t.setCost.execute(t.context, t.input(fixture.cost, null)));
      expect(valueOf(await t.setCost.execute(t.context, t.input(null, 1)))).toEqual({
        status: 'cleared',
        seriesVersion: 2,
      });
      expect(t.costs.records.map((record) => record.cleared)).toEqual([false, true]);
      expect(t.audit.rows.map((entry) => entry.action)).toEqual([
        'pricing.cost.set',
        'pricing.cost.cleared',
      ]);
      expect(t.costs.stored(market, t.offerId, t.variantId)!.latest!.amount).toBeNull();
    });

    it('answers conflict.stale when the screen version is not the stored one', async () => {
      const t = setup();
      valueOf(await t.setCost.execute(t.context, t.input(fixture.cost, null)));
      expect(await t.setCost.execute(t.context, t.input(fixture.cost + 5n, null))).toEqual({
        ok: false,
        error: { code: 'conflict.stale' },
      });
      expect(await t.setCost.execute(t.context, t.input(fixture.cost + 5n, 7))).toEqual({
        ok: false,
        error: { code: 'conflict.stale' },
      });
      expect(await t.setCost.execute(t.context, t.input(null, 3))).toEqual({
        ok: false,
        error: { code: 'conflict.stale' },
      });
    });

    it('refuses another currency, zero and an amount above the safe integer, before any Offer read', async () => {
      const t = setup();
      expect(
        await t.setCost.execute(t.context, {
          ...t.input(null, null),
          cost: { amount: '100', currency: fixture.other },
        }),
      ).toEqual({ ok: false, error: { code: 'pricing.currency-mismatch' } });
      expect(await t.setCost.execute(t.context, t.input(0n, null))).toEqual({
        ok: false,
        error: { code: 'pricing.amount-out-of-range' },
      });
      expect(await t.setCost.execute(t.context, t.input(9_007_199_254_740_992n, null))).toEqual({
        ok: false,
        error: { code: 'pricing.amount-out-of-range' },
      });
      expect(t.offers.calls).toHaveLength(0);
    });

    it('answers validation errors with paths and codes only, never the value', async () => {
      const t = setup();
      const result = await t.setCost.execute(t.context, {
        offerId: 'not-an-id',
        variantId: t.variantId,
        cost: { amount: `-${CANARY}`, currency: 'aud' },
        expectedVersion: 0,
      });
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [
            { path: 'offerId', code: 'format' },
            { path: 'cost.amount', code: 'format' },
            { path: 'cost.currency', code: 'format' },
            { path: 'expectedVersion', code: 'format' },
          ],
        },
      });
      expect(JSON.stringify(result)).not.toContain(CANARY.toString());
    });

    it.each([
      ['another seller', 'not-yours'],
      ['a deleted Offer', 'deleted'],
      ['a Variant outside the sell units', 'variant-not-priceable'],
      ['an unknown Offer', 'absent'],
    ] as const)(
      'answers %s with the one pricing.offer-not-found and a refusal row (cause %s)',
      async (_name, cause) => {
        const t = setup();
        let input = t.input(fixture.cost, null);
        if (cause === 'not-yours') {
          t.offers.put(market, t.offerId, {
            sellerId: t.ids.next<'Seller'>(),
            productId: t.productId,
            deleted: false,
            priceableVariantIds: [t.variantId],
          });
        } else if (cause === 'deleted') {
          t.offers.put(market, t.offerId, {
            sellerId: t.sellerId,
            productId: t.productId,
            deleted: true,
            priceableVariantIds: [],
          });
        } else if (cause === 'variant-not-priceable') {
          input = { ...input, variantId: t.ids.next<'Variant'>() };
        } else {
          input = { ...input, offerId: t.ids.next<'Offer'>() };
        }
        expect(await t.setCost.execute(t.context, input)).toEqual({
          ok: false,
          error: { code: 'pricing.offer-not-found' },
        });
        expect(t.costs.records).toHaveLength(0);
        expect(t.audit.rows).toEqual([
          expect.objectContaining({
            action: 'pricing.offer-write.refused',
            after: expect.objectContaining({ cause }) as unknown,
          }),
        ]);
      },
    );

    it('refuses a stored series whose seller copy is another seller (Hassan L3), writing nothing', async () => {
      const t = setup();
      valueOf(await t.setCost.execute(t.context, t.input(fixture.cost, null)));
      const stored = t.costs.stored(market, t.offerId, t.variantId)!;
      t.costs.putStored(market, { ...stored, sellerId: t.ids.next<'Seller'>() });
      expect(await t.setCost.execute(t.context, t.input(fixture.cost + 1n, 1))).toEqual({
        ok: false,
        error: { code: 'pricing.offer-not-found' },
      });
      expect(t.costs.records).toHaveLength(1);
    });

    it('answers pricing.offer-not-found when a tombstone refuses the creation (key-retired)', async () => {
      const t = setup();
      t.costs.retiredOffers.add(`${market.marketId}|${t.offerId}`);
      expect(await t.setCost.execute(t.context, t.input(fixture.cost, null))).toEqual({
        ok: false,
        error: { code: 'pricing.offer-not-found' },
      });
      expect(t.audit.rows.map((entry) => entry.action)).toEqual(['pricing.offer-write.refused']);
    });

    it('is refused in a Login as Seller session before any read (Hassan finding 6)', async () => {
      const t = setup();
      const result = await t.setCost.execute(
        actingAs(t.context, t.ids.next<'Account'>()),
        t.input(fixture.cost, null),
      );
      expect(result.ok).toBe(false);
      expect(t.offers.calls).toHaveLength(0);
      expect(t.unitOfWork.units).toHaveLength(0);
    });

    it('is refused for an actor that is not a seller', async () => {
      const t = setup();
      const admin = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: t.ids.next<'Account'>(),
          sessionId: t.ids.next<'Session'>(),
          sellerId: null,
        }),
      );
      expect(await t.setCost.execute(admin, t.input(fixture.cost, null))).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });
  });

  describe('pricing.view-cost', () => {
    it('answers every priceable Variant with its version and current Cost, null where none', async () => {
      const t = setup();
      valueOf(await t.setCost.execute(t.context, t.input(fixture.cost, null)));
      const view = valueOf(await t.viewCosts.execute(t.context, { offerId: t.offerId }));

      expect(view.offerId).toBe(t.offerId);
      expect(view.currency).toBe(fixture.currency);
      const byVariant = new Map(view.variants.map((variant) => [variant.variantId, variant]));
      expect(byVariant.get(t.otherVariantId)).toEqual({
        variantId: t.otherVariantId,
        seriesVersion: null,
        cost: null,
      });
      const priced = byVariant.get(t.variantId)!;
      expect(priced.seriesVersion).toBe(1);
      expect(revealCostMinor(priced.cost!)).toEqual({
        amount: fixture.cost,
        currency: fixture.currency,
      });
      expect(t.unitOfWork.units.at(-1)!.options).toEqual({ readOnly: true });
    });

    it('answers a cleared Cost as none, with the version for the next write', async () => {
      const t = setup();
      valueOf(await t.setCost.execute(t.context, t.input(fixture.cost, null)));
      valueOf(await t.setCost.execute(t.context, t.input(null, 1)));
      const view = valueOf(await t.viewCosts.execute(t.context, { offerId: t.offerId }));
      expect(view.variants.find((variant) => variant.variantId === t.variantId)).toEqual({
        variantId: t.variantId,
        seriesVersion: 2,
        cost: null,
      });
    });

    it('hides a series whose seller copy is another seller (Hassan L3)', async () => {
      const t = setup();
      valueOf(await t.setCost.execute(t.context, t.input(fixture.cost, null)));
      const stored = t.costs.stored(market, t.offerId, t.variantId)!;
      t.costs.putStored(market, { ...stored, sellerId: t.ids.next<'Seller'>() });
      const view = valueOf(await t.viewCosts.execute(t.context, { offerId: t.offerId }));
      expect(view.variants.every((variant) => variant.cost === null)).toBe(true);
    });

    it('answers another seller, a deleted or an unknown Offer with one pricing.offer-not-found, reading no Cost', async () => {
      const t = setup();
      const other = t.ids.next<'Offer'>();
      t.offers.put(market, other, {
        sellerId: t.ids.next<'Seller'>(),
        productId: t.productId,
        deleted: false,
        priceableVariantIds: [t.variantId],
      });
      const deleted = t.ids.next<'Offer'>();
      t.offers.put(market, deleted, {
        sellerId: t.sellerId,
        productId: t.productId,
        deleted: true,
        priceableVariantIds: [],
      });
      for (const offerId of [other, deleted, t.ids.next<'Offer'>()]) {
        expect(await t.viewCosts.execute(t.context, { offerId })).toEqual({
          ok: false,
          error: { code: 'pricing.offer-not-found' },
        });
      }
      expect(t.unitOfWork.units).toHaveLength(0);
    });

    it('is refused in a Login as Seller session before any read (Hassan finding 6)', async () => {
      const t = setup();
      const result = await t.viewCosts.execute(actingAs(t.context, t.ids.next<'Account'>()), {
        offerId: t.offerId,
      });
      expect(result.ok).toBe(false);
      expect(t.unitOfWork.units).toHaveLength(0);
      expect(t.offers.calls).toHaveLength(0);
    });

    it('answers a malformed Offer id with a path and code only', async () => {
      const t = setup();
      expect(await t.viewCosts.execute(t.context, { offerId: 'x' })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'offerId', code: 'format' }] },
      });
    });
  });

  it('never logs a Cost: every log line of a write, a read and a refusal is free of the amount (Hassan finding 5)', async () => {
    const t = setup();
    valueOf(await t.setCost.execute(t.context, t.input(CANARY, null)));
    valueOf(await t.viewCosts.execute(t.context, { offerId: t.offerId }));
    await t.setCost.execute(t.context, t.input(CANARY, 9));
    await t.setCost.execute(t.context, { ...t.input(CANARY, 1), offerId: t.ids.next<'Offer'>() });
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain(CANARY.toString());
    expect(JSON.stringify(t.audit.rows)).not.toContain(CANARY.toString());
  });
});
