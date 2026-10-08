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
import { PriceSeries } from '../../domain/price-series';
import { ConfigPricingPolicyProvider } from '../../infrastructure/config-pricing-policy-provider';
import { OfferSellUnitsUnavailableError } from '../ports/offer-sell-units';
import { REFUSAL_ROWS_PER_ACTOR } from '../refusals/offer-write-refusal';
import { SetRegularPrice, type SetRegularPriceInput } from './set-regular-price.use-case';

// `pricing.set-regular-price` in memory (pricing design 3.1, 4.4, 5.2, 8, 9; slice 1 part 3b),
// on both Market fixtures: AU (AUD, GST-inclusive, T = 1/2 both ways) and the synthetic ZZ
// (JPY with exponent 0, tax-exclusive, T = 1/4 upward only). The gate runs with a check that
// admits every authenticated actor; the declaration itself is checked by the CI list. The
// database behaviour (isolation, rollback, lock order) is in test/db/pricing-set-regular-price.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const policies = new ConfigPricingPolicyProvider(markets);

const FIXTURES = {
  AU: { currency: 'AUD', other: 'JPY', base: 10_000n, max: 500_000n, held: 15_001n },
  ZZ: { currency: 'JPY', other: 'AUD', base: 1_000n, max: 2_000_000n, held: 1_251n },
} as const;

describe.each(['AU', 'ZZ'] as const)('pricing.set-regular-price in market %s', (code) => {
  const fixture = FIXTURES[code];
  const logged: unknown[] = [];
  beforeEach(() => {
    logged.length = 0;
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(message);
    });
  });
  afterEach(() => jest.restoreAllMocks());
  const market: MarketContext = testMarketContext(code, 'default');
  const T0 = Temporal.Instant.from('2026-10-08T10:00:00Z');

  function setup() {
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const unitOfWork = new FakeUnitOfWork();
    const series = new InMemoryPriceSeries();
    const throttles = new InMemoryRefusalThrottles();
    const offers = new FakeOfferSellUnits();
    const audit = new RecordingAuditWriter();
    const outbox = new RecordingOutbox();
    const useCase = new SetRegularPrice(gate, {
      unitOfWork,
      series,
      throttles,
      offers,
      policies,
      audit,
      outbox,
      clock,
      ids,
    });
    const sellerId = ids.next<'Seller'>();
    const accountId = ids.next<'Account'>();
    const context = sellerContext(sellerId, accountId, ids);
    const offerId = ids.next<'Offer'>();
    const variantId = ids.next<'Variant'>();
    const productId = ids.next<'Product'>();
    offers.put(market, offerId, {
      sellerId,
      productId,
      deleted: false,
      priceableVariantIds: [variantId],
    });
    const input = (amount: bigint, expectedVersion: number | null): SetRegularPriceInput => ({
      offerId,
      variantId,
      price: { amount: amount.toString(), currency: fixture.currency },
      expectedVersion,
    });
    const advance = (ms: number) => clock.set(clock.now().add({ milliseconds: ms }));
    return {
      clock,
      ids,
      unitOfWork,
      series,
      throttles,
      offers,
      audit,
      outbox,
      useCase,
      sellerId,
      accountId,
      context,
      offerId,
      variantId,
      productId,
      input,
      advance,
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

  const valueOf = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value;
  };

  it('declares pricing.price.edit, denied while the seller is not approved (design 5.2)', () => {
    expect(SetRegularPrice.access).toEqual({
      name: 'pricing.set-regular-price',
      rule: { kind: 'permissions', allOf: ['pricing.price.edit'] },
      whenSellerNotApproved: 'deny',
    });
  });

  describe('a first price', () => {
    it('creates the series in a serializable unit with the copies from catalog, the audit row and the event', async () => {
      const t = setup();
      const output = valueOf(await t.useCase.execute(t.context, t.input(fixture.max, null)));

      expect(output).toEqual({
        status: 'accepted',
        seriesVersion: 2,
        recordId: expect.any(String) as unknown,
        effectiveFrom: t.clock.now(),
      });
      const stored = t.series.stored(market, { offerId: t.offerId, variantId: t.variantId })!;
      expect(stored).toMatchObject({
        productId: t.productId,
        sellerId: t.sellerId,
        currency: fixture.currency,
        version: 2,
      });
      expect(stored.regular[0]).toMatchObject({
        taxInclusive: markets.get(market.marketId).pricesIncludeTax,
        submittedBy: t.accountId,
        status: 'ACCEPTED',
      });
      expect(t.unitOfWork.units.map((u) => u.options)).toEqual([{}, { isolation: 'serializable' }]);
      expect(t.audit.rows).toEqual([
        expect.objectContaining({
          action: 'pricing.regular-price.accepted',
          targetType: 'pricing.price-series',
          targetId: stored.id,
          after: {
            offerId: t.offerId,
            variantId: t.variantId,
            recordId: output.recordId,
            anchorRecordId: null,
            previousRecordId: null,
            effectiveFrom: t.clock.now(),
          },
        }),
      ]);
      expect(t.outbox.events.map((e) => [e.type, e.aggregateVersion])).toEqual([
        ['pricing.effective-price-changed.v1', 2],
      ]);
      expect(t.offers.calls).toEqual([[t.offerId]]);
    });

    it('takes productId only from catalog, whatever the request carries', async () => {
      const t = setup();
      const input = { ...t.input(fixture.base, null), productId: t.ids.next<'Product'>() };
      valueOf(await t.useCase.execute(t.context, input));
      expect(t.series.stored(market, t)!.productId).toBe(t.productId);
    });

    it('lets a proposed Variant be priced: any Variant catalog lists as a sell unit', async () => {
      const t = setup();
      const proposed = t.ids.next<'Variant'>();
      t.offers.put(market, t.offerId, {
        sellerId: t.sellerId,
        productId: t.productId,
        deleted: false,
        priceableVariantIds: [t.variantId, proposed],
      });
      const output = valueOf(
        await t.useCase.execute(t.context, { ...t.input(fixture.base, null), variantId: proposed }),
      );
      expect(output.status).toBe('accepted');
    });

    it('answers conflict.stale when the screen showed a series that does not exist', async () => {
      const t = setup();
      expect(await t.useCase.execute(t.context, t.input(fixture.base, 2))).toEqual({
        ok: false,
        error: { code: 'conflict.stale' },
      });
      expect(t.series.rows.size).toBe(0);
      expect(t.audit.rows).toEqual([]);
    });
  });

  describe('a later price (READ COMMITTED unit on the existing series)', () => {
    async function priced() {
      const t = setup();
      const first = valueOf(await t.useCase.execute(t.context, t.input(fixture.base, null)));
      t.advance(1000);
      t.audit.rows.length = 0;
      t.outbox.events.length = 0;
      t.unitOfWork.units.length = 0;
      return { t, first };
    }

    it('accepts a change inside the threshold and names the previous and anchor records', async () => {
      const { t, first } = await priced();
      const output = valueOf(
        await t.useCase.execute(t.context, t.input(fixture.base + 1n, first.seriesVersion)),
      );

      expect(output).toMatchObject({ status: 'accepted', seriesVersion: 3 });
      expect(t.unitOfWork.units.map((u) => u.options)).toEqual([{}]);
      expect(t.audit.rows.map((r) => [r.action, r.after])).toEqual([
        [
          'pricing.regular-price.accepted',
          expect.objectContaining({
            anchorRecordId: first.recordId,
            previousRecordId: first.recordId,
          }),
        ],
      ]);
    });

    it('holds a jump: pending-review is a success, with the hold audit row and event, no amount', async () => {
      const { t, first } = await priced();
      const output = valueOf(
        await t.useCase.execute(t.context, t.input(fixture.held, first.seriesVersion)),
      );

      expect(output).toEqual({
        status: 'pending-review',
        seriesVersion: 3,
        recordId: expect.any(String) as unknown,
        effectiveFrom: null,
      });
      expect(t.audit.rows.map((r) => [r.action, r.after])).toEqual([
        [
          'pricing.regular-price.held',
          {
            offerId: t.offerId,
            variantId: t.variantId,
            recordId: output.recordId,
            anchorRecordId: first.recordId,
            direction: 'up',
          },
        ],
      ]);
      expect(t.outbox.events.map((e) => e.type)).toEqual(['pricing.price-hold-opened.v1']);
      expect(JSON.stringify(t.outbox.events.map((e) => e.payload))).not.toContain(
        fixture.held.toString(),
      );
    });

    it('supersedes a pending record with a new write: one row and one event per transition, in order', async () => {
      const { t, first } = await priced();
      const held = valueOf(
        await t.useCase.execute(t.context, t.input(fixture.held, first.seriesVersion)),
      );
      t.advance(1000);
      t.audit.rows.length = 0;
      t.outbox.events.length = 0;
      const next = valueOf(
        await t.useCase.execute(t.context, t.input(fixture.base + 2n, held.seriesVersion)),
      );

      expect(t.audit.rows.map((r) => [r.action, r.after])).toEqual([
        [
          'pricing.regular-price.superseded',
          {
            offerId: t.offerId,
            variantId: t.variantId,
            recordId: held.recordId,
            cause: 'replaced',
            supersededByRecordId: next.recordId,
          },
        ],
        ['pricing.regular-price.accepted', expect.objectContaining({ recordId: next.recordId })],
      ]);
      expect(t.outbox.events.map((e) => [e.type, e.aggregateVersion])).toEqual([
        ['pricing.price-hold-decided.v1', 4],
        ['pricing.effective-price-changed.v1', 5],
      ]);
      expect(next.seriesVersion).toBe(5);
    });

    it('cancels a pending change with a write equal to the price in force', async () => {
      const { t, first } = await priced();
      const held = valueOf(
        await t.useCase.execute(t.context, t.input(fixture.held, first.seriesVersion)),
      );
      t.audit.rows.length = 0;
      t.outbox.events.length = 0;
      const output = valueOf(
        await t.useCase.execute(t.context, t.input(fixture.base, held.seriesVersion)),
      );

      expect(output).toEqual({
        status: 'unchanged',
        seriesVersion: 4,
        recordId: null,
        effectiveFrom: null,
      });
      expect(t.audit.rows.map((r) => [r.action, (r.after as { cause: string }).cause])).toEqual([
        ['pricing.regular-price.superseded', 'cancelled'],
      ]);
      expect(t.outbox.events.map((e) => e.type)).toEqual(['pricing.price-hold-decided.v1']);
    });

    it('writes nothing for a write equal to the price in force with nothing pending', async () => {
      const { t, first } = await priced();
      const saves = t.series.saves;
      const output = valueOf(
        await t.useCase.execute(t.context, t.input(fixture.base, first.seriesVersion)),
      );

      expect(output).toEqual({
        status: 'unchanged',
        seriesVersion: first.seriesVersion,
        recordId: null,
        effectiveFrom: null,
      });
      expect(t.series.saves).toBe(saves);
      expect(t.audit.rows).toEqual([]);
      expect(t.outbox.events).toEqual([]);
    });

    it('answers conflict.stale for a version the series no longer has, and writes nothing', async () => {
      const { t, first } = await priced();
      valueOf(await t.useCase.execute(t.context, t.input(fixture.base + 1n, first.seriesVersion)));
      t.audit.rows.length = 0;
      const before = t.series.stored(market, t);

      expect(
        await t.useCase.execute(t.context, t.input(fixture.base + 2n, first.seriesVersion)),
      ).toEqual({ ok: false, error: { code: 'conflict.stale' } });
      expect(t.series.stored(market, t)).toBe(before);
      expect(t.audit.rows).toEqual([]);
    });

    it('answers pricing.series-retired for a retired series', async () => {
      const { t, first } = await priced();
      const loaded = PriceSeries.restore(t.series.stored(market, t)!);
      loaded.retire('offer-removed', t.clock.now());
      await t.series.save(market, loaded);

      expect(
        await t.useCase.execute(t.context, t.input(fixture.base + 1n, first.seriesVersion + 1)),
      ).toEqual({ ok: false, error: { code: 'pricing.series-retired' } });
      expect(t.audit.rows).toEqual([]);
    });
  });

  describe('pricing.offer-not-found: one answer and one path for every cause (design 5.2, 8)', () => {
    type Arrange = (t: ReturnType<typeof setup>) => SetRegularPriceInput;
    const causes: [string, Arrange][] = [
      ['absent', (t) => ({ ...t.input(fixture.base, null), offerId: t.ids.next<'Offer'>() })],
      [
        'not-yours',
        (t) => {
          t.offers.put(market, t.offerId, {
            sellerId: t.ids.next<'Seller'>(),
            productId: t.productId,
            deleted: false,
            priceableVariantIds: [t.variantId],
          });
          return t.input(fixture.base, null);
        },
      ],
      [
        'deleted',
        (t) => {
          t.offers.put(market, t.offerId, {
            sellerId: t.sellerId,
            productId: t.productId,
            deleted: true,
            priceableVariantIds: [],
          });
          return t.input(fixture.base, null);
        },
      ],
      [
        'variant-not-priceable',
        (t) => ({ ...t.input(fixture.base, null), variantId: t.ids.next<'Variant'>() }),
      ],
      [
        'key-retired',
        (t) => {
          t.series.retireOffer(market, t.offerId);
          return t.input(fixture.base, null);
        },
      ],
      [
        'key-retired',
        (t) => {
          t.series.retireVariant(market, t.productId, t.variantId);
          return t.input(fixture.base, null);
        },
      ],
    ];

    it.each(causes)(
      'cause %s: the same answer, the cause only inside the audit row',
      async (cause, arrange) => {
        const t = setup();
        const input = arrange(t);
        const result = await t.useCase.execute(t.context, input);

        expect(JSON.stringify(result)).toBe(
          JSON.stringify({ ok: false, error: { code: 'pricing.offer-not-found' } }),
        );
        expect(t.series.rows.size).toBe(0);
        expect(t.outbox.events).toEqual([]);
        expect(t.audit.rows).toEqual([
          expect.objectContaining({
            action: 'pricing.offer-write.refused',
            targetType: 'pricing.offer',
            targetId: input.offerId,
            actorKind: 'authenticated',
            after: { variantId: input.variantId, cause },
          }),
        ]);
      },
    );

    it('records one row per (actor, Offer) per minute, then again after the minute', async () => {
      const t = setup();
      const input = { ...t.input(fixture.base, null), offerId: t.ids.next<'Offer'>() };
      await t.useCase.execute(t.context, input);
      t.advance(59_000);
      await t.useCase.execute(t.context, input);
      expect(t.audit.rows).toHaveLength(1);
      t.advance(1_000);
      await t.useCase.execute(t.context, input);
      expect(t.audit.rows).toHaveLength(2);
    });

    it('caps an actor at 20 rows a minute, then writes one summary with the window start and no count', async () => {
      const t = setup();
      const windowStart = t.clock.now();
      for (let i = 0; i < REFUSAL_ROWS_PER_ACTOR + 5; i += 1) {
        const result = await t.useCase.execute(t.context, {
          ...t.input(fixture.base, null),
          offerId: t.ids.next<'Offer'>(),
        });
        expect(result).toEqual({ ok: false, error: { code: 'pricing.offer-not-found' } });
        t.advance(100);
      }

      const actions = t.audit.rows.map((r) => r.action);
      expect(actions.filter((a) => a === 'pricing.offer-write.refused')).toHaveLength(
        REFUSAL_ROWS_PER_ACTOR,
      );
      const summaries = t.audit.rows.filter(
        (r) => r.action === 'pricing.offer-write-refused.suppressed',
      );
      expect(summaries).toEqual([
        expect.objectContaining({
          targetType: 'pricing.write-refusal-actor',
          targetId: t.accountId,
          after: { windowStartedAt: windowStart },
        }),
      ]);
    });

    it('does not use up the cap with repeats on one Offer (the slot is given back)', async () => {
      const t = setup();
      const same = { ...t.input(fixture.base, null), offerId: t.ids.next<'Offer'>() };
      for (let i = 0; i < 30; i += 1) await t.useCase.execute(t.context, same);
      for (let i = 0; i < REFUSAL_ROWS_PER_ACTOR - 1; i += 1) {
        await t.useCase.execute(t.context, {
          ...t.input(fixture.base, null),
          offerId: t.ids.next<'Offer'>(),
        });
      }
      expect(t.audit.rows.map((r) => r.action)).toEqual(
        Array.from({ length: REFUSAL_ROWS_PER_ACTOR }, () => 'pricing.offer-write.refused'),
      );
    });

    it('takes the actor row before the (actor, Offer) row, and skips the pair once suppressed', async () => {
      const t = setup();
      for (let i = 0; i < REFUSAL_ROWS_PER_ACTOR + 2; i += 1) {
        await t.useCase.execute(t.context, {
          ...t.input(fixture.base, null),
          offerId: t.ids.next<'Offer'>(),
        });
      }
      const order = t.throttles.touched;
      expect(order.slice(0, 2)).toEqual(['actor', 'offer']);
      expect(order.slice(-2)).toEqual(['actor', 'actor']);
      expect(t.throttles.pairs.size).toBe(REFUSAL_ROWS_PER_ACTOR);
    });

    it("refuses another Market's Offer: catalog answers it as absent", async () => {
      const t = setup();
      const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
      const foreign = t.ids.next<'Offer'>();
      t.offers.put(other, foreign, {
        sellerId: t.sellerId,
        productId: t.productId,
        deleted: false,
        priceableVariantIds: [t.variantId],
      });
      expect(
        await t.useCase.execute(t.context, { ...t.input(fixture.base, null), offerId: foreign }),
      ).toEqual({ ok: false, error: { code: 'pricing.offer-not-found' } });
    });
  });

  describe('input and the Market limits, checked before catalog is asked (design 4.4)', () => {
    it.each([
      ['offerId', { offerId: 'not-an-id' }],
      ['variantId', { variantId: '' }],
      ['price.amount', { price: { amount: '01', currency: 'XXX' } }],
      ['price.amount', { price: { amount: '-1', currency: 'XXX' } }],
      ['price.amount', { price: { amount: '1.5', currency: 'XXX' } }],
      ['price.amount', { price: { amount: '12345678901234567', currency: 'XXX' } }],
      ['price.amount', { price: { amount: 100, currency: 'XXX' } }],
      ['price.currency', { price: { amount: '100', currency: 'aud' } }],
      ['expectedVersion', { expectedVersion: 0 }],
      ['expectedVersion', { expectedVersion: 1.5 }],
    ])('refuses a malformed %s with its path and code only', async (path, change) => {
      const t = setup();
      const base = t.input(fixture.base, null);
      const input = {
        ...base,
        ...change,
        price: 'price' in change ? { ...change.price } : base.price,
      };
      if ('price' in change && change.price.currency === 'XXX') {
        (input.price as { currency: string }).currency = fixture.currency;
      }
      const result = await t.useCase.execute(t.context, input as SetRegularPriceInput);

      expect(result).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path, code: 'format' }] },
      });
      expect(JSON.stringify(result)).not.toContain('12345678901234567');
      expect(t.offers.calls).toEqual([]);
    });

    it("refuses another Market's currency (never assumed, AC 1)", async () => {
      const t = setup();
      const input = {
        ...t.input(fixture.base, null),
        price: { amount: '100', currency: fixture.other },
      };
      expect(await t.useCase.execute(t.context, input)).toEqual({
        ok: false,
        error: { code: 'pricing.currency-mismatch' },
      });
      expect(t.offers.calls).toEqual([]);
    });

    it.each([0n, fixture.max + 1n])(
      'refuses %s minor units (above 0, at most the maximum, AC 4)',
      async (amount) => {
        const t = setup();
        expect(await t.useCase.execute(t.context, t.input(amount, null))).toEqual({
          ok: false,
          error: { code: 'pricing.amount-out-of-range' },
        });
        expect(t.offers.calls).toEqual([]);
      },
    );
  });

  describe('logs (P 12.3)', () => {
    it('logs ids, codes and the correlation id, never an amount or a refusal cause', async () => {
      const t = setup();
      const amount = 123_457n;
      await t.useCase.execute(t.context, t.input(amount, null));
      await t.useCase.execute(t.context, {
        ...t.input(fixture.base, null),
        offerId: t.ids.next<'Offer'>(),
      });

      expect(logged).toEqual([
        expect.objectContaining({
          msg: 'pricing.set-regular-price.done',
          status: 'accepted',
          correlationId: t.context.correlationId,
          marketId: market.marketId,
        }),
        expect.objectContaining({
          msg: 'pricing.set-regular-price.offer-not-found',
          correlationId: t.context.correlationId,
        }),
      ]);
      const text = JSON.stringify(logged);
      expect(text).not.toContain(amount.toString());
      expect(text).not.toContain('absent');
    });
  });

  describe('who may write', () => {
    it.each(['customer', 'admin'] as const)(
      'refuses a %s even when the gate admits it',
      async (population) => {
        const t = setup();
        const context = testCallContext(
          market,
          testAuthenticatedActor(market, {
            population,
            accountId: t.ids.next<'Account'>(),
            sessionId: t.ids.next<'Session'>(),
            sellerId: null,
          }),
        );
        expect(await t.useCase.execute(context, t.input(fixture.base, null))).toEqual({
          ok: false,
          error: { code: 'access.denied' },
        });
        expect(t.offers.calls).toEqual([]);
      },
    );

    it('fails, writing nothing, when catalog cannot answer (never read as absent or present)', async () => {
      const t = setup();
      t.offers.fail = new OfferSellUnitsUnavailableError('validation.failed');
      await expect(
        t.useCase.execute(t.context, t.input(fixture.base, null)),
      ).rejects.toBeInstanceOf(OfferSellUnitsUnavailableError);
      expect(t.series.rows.size).toBe(0);
      expect(t.audit.rows).toEqual([]);
      expect(t.unitOfWork.units).toEqual([]);
    });
  });
});
