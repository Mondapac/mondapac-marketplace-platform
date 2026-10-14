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
import { SetSpecialPrice, type SetSpecialPriceInput } from './set-special-price.use-case';
import { WithdrawSpecialPrice } from './withdraw-special-price.use-case';

// `pricing.set-special-price` and `pricing.withdraw-special-price` in memory (pricing design 3.2,
// 5.2, 8, 9; slice 5), on both Market fixtures. The ownership and refusal behaviour is that of
// `pricing.set-regular-price`: the same helper runs it. The database behaviour is in
// test/db/pricing-special-price.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const policies = new ConfigPricingPolicyProvider(markets);

const FIXTURES = {
  // `deep`: a discount of more than the threshold. AU holds it; ZZ holds upward moves only.
  AU: { currency: 'AUD', other: 'JPY', base: 10_000n, special: 9_000n, deep: 4_000n },
  ZZ: { currency: 'JPY', other: 'AUD', base: 1_000n, special: 900n, deep: 100n },
} as const;

const HOUR = 3_600_000;

describe.each(['AU', 'ZZ'] as const)('special price use cases in market %s', (code) => {
  const fixture = FIXTURES[code];
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  const market: MarketContext = testMarketContext(code, 'default');
  const T0 = Temporal.Instant.from('2026-10-08T10:00:00Z');

  /** A seller with an Offer whose Variant has a regular price in force. */
  async function setup() {
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const unitOfWork = new FakeUnitOfWork();
    const series = new InMemoryPriceSeries();
    const throttles = new InMemoryRefusalThrottles();
    const counters = new InMemoryWriteRateCounters();
    const offers = new FakeOfferSellUnits();
    const audit = new RecordingAuditWriter();
    const outbox = new RecordingOutbox();
    const deps = { unitOfWork, series, throttles, counters, offers, audit, outbox, clock };
    const setSpecial = new SetSpecialPrice(gate, { ...deps, policies, ids });
    const withdraw = new WithdrawSpecialPrice(gate, deps);
    const sellerId = ids.next<'Seller'>();
    const accountId = ids.next<'Account'>();
    const context = contextOf('seller', accountId, sellerId, ids);
    const offerId = ids.next<'Offer'>();
    const variantId = ids.next<'Variant'>();
    offers.put(market, offerId, {
      sellerId,
      productId: ids.next<'Product'>(),
      deleted: false,
      priceableVariantIds: [variantId],
    });
    const setRegular = new SetRegularPrice(gate, { ...deps, policies, ids });
    const first = await setRegular.execute(context, {
      offerId,
      variantId,
      price: { amount: fixture.base.toString(), currency: fixture.currency },
      expectedVersion: null,
    });
    if (!first.ok) throw new Error('setup');
    audit.rows.length = 0;
    outbox.events.length = 0;
    unitOfWork.units.length = 0;
    const key = { offerId, variantId };
    const advance = (ms: number) => clock.set(clock.now().add({ milliseconds: ms }));
    const version = () => series.stored(market, key)!.version;
    const input = (
      amount: bigint,
      over: Partial<SetSpecialPriceInput> = {},
    ): SetSpecialPriceInput => ({
      offerId,
      variantId,
      price: { amount: amount.toString(), currency: fixture.currency },
      startsAt: null,
      endsAt: clock
        .now()
        .add({ milliseconds: 24 * HOUR })
        .toString(),
      expectedVersion: version(),
      ...over,
    });
    return {
      clock,
      ids,
      unitOfWork,
      series,
      throttles,
      counters,
      offers,
      audit,
      outbox,
      setSpecial,
      withdraw,
      sellerId,
      accountId,
      context,
      offerId,
      variantId,
      key,
      input,
      advance,
      version,
    };
  }

  function contextOf(
    population: 'seller' | 'admin',
    accountId: Id<'Account'>,
    sellerId: Id<'Seller'> | null,
    ids: SequenceIdGenerator,
  ): CallContext {
    return testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
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
  const codeOf = (result: { ok: boolean; error?: { code: string } }): string =>
    result.ok ? 'ok' : (result.error as { code: string }).code;

  it('declares pricing.price.edit, denied while the seller is not approved', () => {
    expect(SetSpecialPrice.access).toEqual({
      name: 'pricing.set-special-price',
      rule: { kind: 'permissions', allOf: ['pricing.price.edit'] },
      whenSellerNotApproved: 'deny',
    });
    expect(WithdrawSpecialPrice.access).toEqual({
      name: 'pricing.withdraw-special-price',
      rule: { kind: 'permissions', allOf: ['pricing.price.edit'] },
      whenSellerNotApproved: 'deny',
    });
  });

  describe('pricing.set-special-price', () => {
    it('accepts a special: one READ COMMITTED unit, the series saved, one audit row, one event', async () => {
      const t = await setup();
      const before = t.version();
      const output = valueOf(await t.setSpecial.execute(t.context, t.input(fixture.special)));

      expect(output).toEqual({
        status: 'accepted',
        seriesVersion: before + 1,
        recordId: expect.any(String) as unknown,
        startsAt: t.clock.now(),
        endsAt: t.clock.now().add({ milliseconds: 24 * HOUR }),
        effectiveFrom: t.clock.now(),
      });
      const stored = t.series.stored(market, t.key)!;
      expect(stored.specials).toHaveLength(1);
      expect(stored.specials[0]).toMatchObject({
        id: output.recordId,
        status: 'ACCEPTED',
        submittedBy: t.accountId,
        taxInclusive: markets.get(market.marketId).pricesIncludeTax,
      });
      // The first unit is the per-account allowance counter; the second is the write.
      expect(t.unitOfWork.units.map((u) => u.options)).toEqual([{}, {}]);
      expect(t.audit.rows).toEqual([
        expect.objectContaining({
          action: 'pricing.special-price.accepted',
          targetType: 'pricing.price-series',
          targetId: stored.id,
          after: {
            offerId: t.offerId,
            variantId: t.variantId,
            recordId: output.recordId,
            amount: { amount: fixture.special, currency: fixture.currency },
            startsAt: t.clock.now(),
            endsAt: t.clock.now().add({ milliseconds: 24 * HOUR }),
            effectiveFrom: t.clock.now(),
          },
        }),
      ]);
      expect(t.outbox.events.map((e) => [e.type, e.aggregateVersion])).toEqual([
        ['pricing.effective-price-changed.v1', before + 1],
      ]);
    });

    it('schedules a special for later: effective from its start, not from now', async () => {
      const t = await setup();
      const startsAt = t.clock.now().add({ milliseconds: 3 * HOUR });
      const output = valueOf(
        await t.setSpecial.execute(
          t.context,
          t.input(fixture.special, {
            startsAt: startsAt.toString(),
            endsAt: startsAt.add({ milliseconds: HOUR }).toString(),
          }),
        ),
      );
      expect(output.effectiveFrom).toEqual(startsAt);
      expect(output.startsAt).toEqual(startsAt);
    });

    it('replaces the running special: audit rows in order, one event', async () => {
      const t = await setup();
      const first = valueOf(await t.setSpecial.execute(t.context, t.input(fixture.special)));
      t.audit.rows.length = 0;
      t.outbox.events.length = 0;
      t.advance(HOUR);
      const second = valueOf(
        await t.setSpecial.execute(t.context, t.input(fixture.special - 100n)),
      );
      expect(
        t.audit.rows.map((row) => [row.action, (row.after as { recordId: string }).recordId]),
      ).toEqual([
        ['pricing.special-price.withdrawn', first.recordId],
        ['pricing.special-price.accepted', second.recordId],
      ]);
      expect(t.audit.rows[0]!.after).toMatchObject({ cause: 'replaced' });
      expect(t.outbox.events.map((e) => e.type)).toEqual(['pricing.effective-price-changed.v1']);
    });

    it('holds a deep discount where the Market holds discounts, accepts it where it does not', async () => {
      const t = await setup();
      const before = t.version();
      const output = valueOf(await t.setSpecial.execute(t.context, t.input(fixture.deep)));
      if (code === 'AU') {
        expect(output).toMatchObject({ status: 'pending-review', effectiveFrom: null });
        expect(t.audit.rows.map((r) => r.action)).toEqual(['pricing.special-price.held']);
        expect(t.audit.rows[0]!.after).toMatchObject({
          amount: { amount: fixture.deep, currency: 'AUD' },
          referenceAmount: { amount: fixture.base, currency: 'AUD' },
        });
        expect(t.outbox.events.map((e) => e.type)).toEqual(['pricing.price-hold-opened.v1']);
      } else {
        expect(output.status).toBe('accepted');
      }
      expect(output.seriesVersion).toBe(before + 1);
    });

    it('refuses bad input before any read, with codes and paths only', async () => {
      const t = await setup();
      const bad = [
        t.input(fixture.special, { startsAt: '2026-10-08T12:00:00+10:00' }),
        t.input(fixture.special, { endsAt: '2026-10-09T10:00:00.1234Z' }),
        t.input(fixture.special, { endsAt: 'tomorrow' }),
        t.input(fixture.special, { endsAt: undefined as unknown as string }),
        t.input(fixture.special, { expectedVersion: null as unknown as number }),
        t.input(fixture.special, { expectedVersion: 0 }),
        { ...t.input(fixture.special), price: { amount: '01', currency: fixture.currency } },
        { ...t.input(fixture.special), offerId: 'x' },
      ];
      for (const input of bad) {
        expect(codeOf(await t.setSpecial.execute(t.context, input))).toBe('validation.failed');
      }
      expect(t.unitOfWork.units).toEqual([]);
      expect(t.audit.rows).toEqual([]);
      expect(t.series.saves).toBe(0);
    });

    it('refuses another currency and an amount out of range without opening a unit', async () => {
      const t = await setup();
      expect(
        codeOf(
          await t.setSpecial.execute(t.context, {
            ...t.input(fixture.special),
            price: { amount: '900', currency: fixture.other },
          }),
        ),
      ).toBe('pricing.currency-mismatch');
      expect(codeOf(await t.setSpecial.execute(t.context, t.input(10n ** 15n)))).toBe(
        'pricing.amount-out-of-range',
      );
      expect(t.unitOfWork.units).toEqual([]);
    });

    it('passes the aggregate refusals through and changes nothing', async () => {
      const t = await setup();
      const version = t.version();
      const cases: [SetSpecialPriceInput, string][] = [
        [t.input(fixture.base), 'pricing.special-not-below-regular'],
        [
          t.input(fixture.special, { startsAt: t.clock.now().subtract({ hours: 1 }).toString() }),
          'pricing.special-window.start-in-past',
        ],
        [
          t.input(fixture.special, { endsAt: t.clock.now().toString() }),
          'pricing.special-window.invalid',
        ],
      ];
      for (const [input, code] of cases) {
        expect(codeOf(await t.setSpecial.execute(t.context, input))).toBe(code);
      }
      expect(t.version()).toBe(version);
      expect(t.audit.rows).toEqual([]);
      expect(t.outbox.events).toEqual([]);
    });

    it('answers conflict.stale for a stale version and writes nothing', async () => {
      const t = await setup();
      const stale = t.input(fixture.special, { expectedVersion: t.version() - 1 });
      expect(codeOf(await t.setSpecial.execute(t.context, stale))).toBe('conflict.stale');
      expect(t.series.saves).toBe(0);
      expect(t.audit.rows).toEqual([]);
    });

    it('needs a regular price first: a Variant without a series answers no-regular-price', async () => {
      const t = await setup();
      const other = t.ids.next<'Variant'>();
      t.offers.put(market, t.offerId, {
        sellerId: t.sellerId,
        productId: t.ids.next<'Product'>(),
        deleted: false,
        priceableVariantIds: [t.variantId, other],
      });
      const result = await t.setSpecial.execute(t.context, {
        ...t.input(fixture.special, { expectedVersion: 1 }),
        variantId: other,
      });
      expect(codeOf(result)).toBe('pricing.no-regular-price');
    });

    it('answers every foreign, deleted or unpriceable Offer with one offer-not-found and one refusal row', async () => {
      const t = await setup();
      const stranger = contextOf('seller', t.ids.next<'Account'>(), t.ids.next<'Seller'>(), t.ids);
      const causes: [string, () => Promise<unknown>][] = [
        ['not-yours', () => t.setSpecial.execute(stranger, t.input(fixture.special))],
        [
          'absent',
          () =>
            t.setSpecial.execute(t.context, {
              ...t.input(fixture.special),
              offerId: t.ids.next<'Offer'>(),
            }),
        ],
        [
          'variant-not-priceable',
          () =>
            t.setSpecial.execute(t.context, {
              ...t.input(fixture.special),
              variantId: t.ids.next<'Variant'>(),
            }),
        ],
      ];
      for (const [cause, run] of causes) {
        t.audit.rows.length = 0;
        t.advance(2 * 60_000);
        const result = (await run()) as { ok: boolean; error: { code: string } };
        expect(result).toEqual({ ok: false, error: { code: 'pricing.offer-not-found' } });
        expect(t.audit.rows.map((r) => [r.action, (r.after as { cause: string }).cause])).toEqual([
          ['pricing.offer-write.refused', cause],
        ]);
      }
      expect(t.series.stored(market, t.key)!.specials).toEqual([]);
    });

    it('denies an admin session and writes nothing', async () => {
      const t = await setup();
      const admin = contextOf('admin', t.ids.next<'Account'>(), null, t.ids);
      expect(codeOf(await t.setSpecial.execute(admin, t.input(fixture.special)))).toBe(
        'access.denied',
      );
      expect(t.series.saves).toBe(0);
    });

    it('refuses a retired series', async () => {
      const t = await setup();
      const loaded = (await t.series.findByKey(market, t.key))!;
      loaded.retire('offer-removed', t.clock.now());
      await t.series.save(market, loaded);
      expect(codeOf(await t.setSpecial.execute(t.context, t.input(fixture.special)))).toBe(
        'pricing.series-retired',
      );
    });
  });

  describe('pricing.withdraw-special-price', () => {
    it('ends the running special now: audit row, event, output', async () => {
      const t = await setup();
      const special = valueOf(await t.setSpecial.execute(t.context, t.input(fixture.special)));
      t.audit.rows.length = 0;
      t.outbox.events.length = 0;
      t.advance(HOUR);
      const before = t.version();
      const output = valueOf(
        await t.withdraw.execute(t.context, {
          offerId: t.offerId,
          variantId: t.variantId,
          expectedVersion: before,
        }),
      );
      expect(output).toEqual({
        seriesVersion: before + 1,
        endedRecordId: special.recordId,
        cancelledRecordId: null,
      });
      expect(t.audit.rows.map((r) => r.action)).toEqual(['pricing.special-price.withdrawn']);
      expect(t.audit.rows[0]!.after).toMatchObject({
        recordId: special.recordId,
        cause: 'withdrawn',
      });
      expect(t.outbox.events.map((e) => [e.type, e.aggregateVersion])).toEqual([
        ['pricing.effective-price-changed.v1', before + 1],
      ]);
    });

    if (code === 'AU') {
      it('cancels a special that waits for review', async () => {
        const t = await setup();
        const pending = valueOf(await t.setSpecial.execute(t.context, t.input(fixture.deep)));
        t.audit.rows.length = 0;
        t.outbox.events.length = 0;
        const output = valueOf(
          await t.withdraw.execute(t.context, {
            offerId: t.offerId,
            variantId: t.variantId,
            expectedVersion: t.version(),
          }),
        );
        expect(output).toMatchObject({ endedRecordId: null, cancelledRecordId: pending.recordId });
        expect(t.audit.rows.map((r) => r.action)).toEqual(['pricing.special-price.superseded']);
        expect(t.audit.rows[0]!.after).toMatchObject({ cause: 'cancelled' });
        expect(t.outbox.events.map((e) => e.type)).toEqual(['pricing.price-hold-decided.v1']);
      });
    }

    it('answers not-found when there is nothing to end, stale for a stale version', async () => {
      const t = await setup();
      const call = (expectedVersion: number) =>
        t.withdraw.execute(t.context, {
          offerId: t.offerId,
          variantId: t.variantId,
          expectedVersion,
        });
      expect(codeOf(await call(t.version()))).toBe('pricing.special-price.not-found');
      expect(codeOf(await call(t.version() - 1))).toBe('conflict.stale');
      expect(t.series.saves).toBe(0);
    });

    it('validates its input and keeps the Offer refusal answer', async () => {
      const t = await setup();
      expect(
        codeOf(
          await t.withdraw.execute(t.context, {
            offerId: t.offerId,
            variantId: 'x',
            expectedVersion: 1.5,
          }),
        ),
      ).toBe('validation.failed');
      const stranger = contextOf('seller', t.ids.next<'Account'>(), t.ids.next<'Seller'>(), t.ids);
      expect(
        await t.withdraw.execute(stranger, {
          offerId: t.offerId,
          variantId: t.variantId,
          expectedVersion: t.version(),
        }),
      ).toEqual({ ok: false, error: { code: 'pricing.offer-not-found' } });
    });
  });
  describe('the per-account write cap', () => {
    it('throttles special-price writes and withdrawals together with the regular price', async () => {
      const t = await setup();
      // The setup's regular price was one attempt of this account; 59 more fill the minute.
      for (let n = 0; n < 59; n += 1) {
        await t.withdraw.execute(t.context, {
          offerId: t.offerId,
          variantId: t.variantId,
          expectedVersion: t.version(),
        });
      }
      const withdrawn = await t.withdraw.execute(t.context, {
        offerId: t.offerId,
        variantId: t.variantId,
        expectedVersion: t.version(),
      });
      expect(withdrawn).toEqual({
        ok: false,
        error: { code: 'request.throttled', retryAfterSeconds: 60 },
      });
      const special = await t.setSpecial.execute(t.context, t.input(fixture.special));
      expect(special).toMatchObject({ ok: false, error: { code: 'request.throttled' } });
      t.advance(60_000);
      expect((await t.setSpecial.execute(t.context, t.input(fixture.special))).ok).toBe(true);
    });
  });
});
