import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
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
  InMemoryPriceSeries,
  InMemoryRefusalThrottles,
  InMemoryTombstones,
  RecordingAuditWriter,
  RecordingOutbox,
} from '../../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { ConfigPricingPolicyProvider } from '../../infrastructure/config-pricing-policy-provider';
import { ApprovePriceHold } from './approve-price-hold.use-case';
import { ListPriceHolds } from './list-price-holds.use-case';
import { RejectPriceHold } from './reject-price-hold.use-case';
import { RetireSeriesForRemovedOffer } from './retire-series-for-removed-offer.use-case';
import { RetireSeriesForRemovedVariant } from './retire-series-for-removed-variant.use-case';
import { SetRegularPrice } from './set-regular-price.use-case';
import { ViewPriceHold } from './view-price-hold.use-case';

// The price-hold review and the retirement handlers in memory (pricing design 3.1, 5.2, 6.4, 8,
// 9), on both Market fixtures. The database behaviour (isolation, races, grants) is in
// test/db/pricing-holds-retirement.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const policies = new ConfigPricingPolicyProvider(markets);

const json = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );

const FIXTURES = {
  AU: { currency: 'AUD', base: 10_000n, held: 15_001n, max: 500_000n },
  ZZ: { currency: 'JPY', base: 1_000n, held: 1_251n, max: 2_000_000n },
} as const;

describe.each(['AU', 'ZZ'] as const)('price-hold review and retirement in market %s', (code) => {
  const fixture = FIXTURES[code];
  const market: MarketContext = testMarketContext(code, 'default');
  const foreign: MarketContext = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const T0 = Temporal.Instant.from('2026-10-10T10:00:00Z');
  const logged: unknown[] = [];

  beforeEach(() => {
    logged.length = 0;
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(message);
    });
  });
  afterEach(() => jest.restoreAllMocks());

  function setup() {
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const unitOfWork = new FakeUnitOfWork();
    const series = new InMemoryPriceSeries();
    const tombstones = new InMemoryTombstones(series);
    const offers = new FakeOfferSellUnits();
    const audit = new RecordingAuditWriter();
    const outbox = new RecordingOutbox();
    const common = { unitOfWork, series, audit, outbox, clock };
    const set = new SetRegularPrice(gate, {
      ...common,
      throttles: new InMemoryRefusalThrottles(),
      offers,
      policies,
      ids,
    });
    const approve = new ApprovePriceHold(gate, { ...common, policies });
    const reject = new RejectPriceHold(gate, common);
    const list = new ListPriceHolds(gate, { unitOfWork, series });
    const view = new ViewPriceHold(gate, { unitOfWork, series });
    const retireOffer = new RetireSeriesForRemovedOffer(gate, { ...common, tombstones });
    const retireVariant = new RetireSeriesForRemovedVariant(gate, { ...common, tombstones });

    const admin = (m: MarketContext = market, accountId = ids.next<'Account'>()): CallContext =>
      testCallContext(
        m,
        testAuthenticatedActor(m, {
          population: 'admin',
          accountId,
          sessionId: ids.next<'Session'>(),
          sellerId: null,
        }),
      );
    const system = (m: MarketContext = market): CallContext => testCallContext(m, 'system');
    const delivery = (subscriber: string) => ({
      eventId: ids.next<'event'>(),
      subscriber,
      attempt: 1,
    });

    /** A seller whose first price is in force and whose second is held. */
    async function held(m: MarketContext = market) {
      const sellerId = ids.next<'Seller'>();
      const accountId = ids.next<'Account'>();
      const offerId = ids.next<'Offer'>();
      const variantId = ids.next<'Variant'>();
      const productId = ids.next<'Product'>();
      offers.put(m, offerId, {
        sellerId,
        productId,
        deleted: false,
        priceableVariantIds: [variantId],
      });
      const context = testCallContext(
        m,
        testAuthenticatedActor(m, {
          population: 'seller',
          accountId,
          sessionId: ids.next<'Session'>(),
          sellerId,
        }),
      );
      const input = (amount: bigint, expectedVersion: number | null) => ({
        offerId,
        variantId,
        price: {
          amount: amount.toString(),
          currency: FIXTURES[m.marketId as 'AU' | 'ZZ'].currency,
        },
        expectedVersion,
      });
      const f = FIXTURES[m.marketId as 'AU' | 'ZZ'];
      await set.execute(context, input(f.base, null));
      clock.set(clock.now().add({ seconds: 5 }));
      const second = await set.execute(context, input(f.held, 2));
      if (!second.ok || second.value.recordId === null) throw new Error('setup: no hold');
      clock.set(clock.now().add({ seconds: 5 }));
      return {
        sellerId,
        accountId,
        offerId,
        variantId,
        productId,
        recordId: second.value.recordId,
      };
    }

    return {
      clock,
      ids,
      unitOfWork,
      series,
      tombstones,
      offers,
      audit,
      outbox,
      set,
      approve,
      reject,
      list,
      view,
      retireOffer,
      retireVariant,
      admin,
      system,
      delivery,
      held,
    };
  }

  describe('pricing.approve-price-hold', () => {
    it('approves from now, with the audit row and the two events, and no amount in an event', async () => {
      const t = setup();
      const h = await t.held();
      t.audit.rows.length = 0;
      t.outbox.events.length = 0;

      const result = await t.approve.execute(t.admin(), { recordId: h.recordId });

      expect(result).toMatchObject({
        ok: true,
        value: { outcome: 'approved', seriesVersion: 5 },
      });
      if (!result.ok) return;
      expect(result.value.effectiveFrom.epochMilliseconds).toBe(t.clock.now().epochMilliseconds);
      expect(t.audit.rows.map((r) => [r.action, r.actorKind, r.market])).toEqual([
        ['pricing.price-hold.approved', 'authenticated', code],
      ]);
      expect(t.audit.rows[0]!.after).toMatchObject({
        recordId: h.recordId,
        amount: { amount: fixture.held, currency: fixture.currency },
        anchorAmount: { amount: fixture.base, currency: fixture.currency },
      });
      expect(t.outbox.events.map((e) => [e.type, e.aggregateVersion])).toEqual([
        ['pricing.price-hold-decided.v1', 4],
        ['pricing.effective-price-changed.v1', 5],
      ]);
      expect(JSON.stringify(t.outbox.events.map((e) => e.payload))).not.toContain('amount');
      // An approval is a READ COMMITTED unit: the version check of the save is its guard.
      expect(t.unitOfWork.units[t.unitOfWork.units.length - 1]!.options).toEqual({});
    });

    it('refuses the submitting account, a decided record, a foreign record and a bad id', async () => {
      const t = setup();
      const h = await t.held();
      const own = t.admin(market, h.accountId);
      expect(await t.approve.execute(own, { recordId: h.recordId })).toEqual({
        ok: false,
        error: { code: 'pricing.hold.own-submission' },
      });
      expect(await t.approve.execute(t.admin(foreign), { recordId: h.recordId })).toEqual({
        ok: false,
        error: { code: 'pricing.hold.not-found' },
      });
      expect(await t.approve.execute(t.admin(), { recordId: 'not-an-id' })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'recordId', code: 'format' }] },
      });
      expect(await t.approve.execute(t.admin(), { recordId: h.recordId })).toMatchObject({
        ok: true,
      });
      expect(await t.approve.execute(t.admin(), { recordId: h.recordId })).toEqual({
        ok: false,
        error: { code: 'pricing.hold.not-pending' },
      });
    });

    it('refuses a seller or a system caller in the use case itself', async () => {
      const t = setup();
      const h = await t.held();
      const seller = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: h.accountId,
          sessionId: t.ids.next<'Session'>(),
          sellerId: h.sellerId,
        }),
      );
      for (const context of [seller, t.system()]) {
        // The gate admits every actor in this suite; the use case still refuses a non-admin.
        const result = await t.approve
          .execute(context, { recordId: h.recordId })
          .catch(() => ({ ok: false as const }));
        expect(result.ok).toBe(false);
      }
      expect(
        t.series.stored(market, { offerId: h.offerId, variantId: h.variantId })?.regular,
      ).toHaveLength(2);
    });

    it('answers conflict.stale when a concurrent write wins the version', async () => {
      const t = setup();
      const h = await t.held();
      const save = t.series.save.bind(t.series);
      t.series.save = () => {
        throw new StaleAggregateError('price-series', 'x');
      };
      expect(await t.approve.execute(t.admin(), { recordId: h.recordId })).toEqual({
        ok: false,
        error: { code: 'conflict.stale' },
      });
      t.series.save = save;
      expect(t.audit.rows.filter((r) => r.action === 'pricing.price-hold.approved')).toHaveLength(
        0,
      );
    });
  });

  describe('pricing.reject-price-hold', () => {
    it('rejects with a reason code, an audit row without the note, one event', async () => {
      const t = setup();
      const h = await t.held();
      t.audit.rows.length = 0;
      t.outbox.events.length = 0;

      const result = await t.reject.execute(t.admin(), {
        recordId: h.recordId,
        reasonCode: 'price-implausible',
        note: '  secret note  ',
      });

      expect(result).toMatchObject({ ok: true, value: { outcome: 'rejected', seriesVersion: 4 } });
      const stored = t.series.stored(market, { offerId: h.offerId, variantId: h.variantId });
      expect(stored?.regular[1]).toMatchObject({
        status: 'REJECTED',
        decision: { reasonCode: 'price-implausible', note: 'secret note' },
      });
      expect(t.audit.rows.map((r) => r.action)).toEqual(['pricing.price-hold.rejected']);
      expect(json(t.audit.rows)).not.toContain('secret');
      expect(json(t.outbox.events)).not.toContain('secret');
      expect(json(logged)).not.toContain('secret');
      expect(t.outbox.events.map((e) => e.payload['outcome'])).toEqual(['rejected']);
    });

    it.each([
      ['no reason', { reasonCode: undefined }, [{ path: 'reasonCode', code: 'enum' }]],
      ['an unknown reason', { reasonCode: 'because' }, [{ path: 'reasonCode', code: 'enum' }]],
      [
        'a note that is too long',
        { reasonCode: 'other', note: 'x'.repeat(1001) },
        [{ path: 'note', code: 'length' }],
      ],
      [
        'a note with a control character',
        { reasonCode: 'other', note: 'a\u0007b' },
        [{ path: 'note', code: 'format' }],
      ],
      [
        'a note that is not text',
        { reasonCode: 'other', note: 5 },
        [{ path: 'note', code: 'type' }],
      ],
    ])('refuses %s', async (_name, extra, fields) => {
      const t = setup();
      const h = await t.held();
      const result = await t.reject.execute(t.admin(), {
        recordId: h.recordId,
        ...extra,
      } as never);
      expect(result).toEqual({ ok: false, error: { code: 'validation.failed', fields } });
      expect(t.audit.rows.filter((r) => r.action === 'pricing.price-hold.rejected')).toHaveLength(
        0,
      );
    });

    it('takes a blank note as none, and a note of exactly 1000 characters', async () => {
      const t = setup();
      const a = await t.held();
      const b = await t.held();
      expect(
        await t.reject.execute(t.admin(), {
          recordId: a.recordId,
          reasonCode: 'other',
          note: '   ',
        }),
      ).toMatchObject({ ok: true });
      expect(
        await t.reject.execute(t.admin(), {
          recordId: b.recordId,
          reasonCode: 'other',
          note: 'é'.repeat(1000),
        }),
      ).toMatchObject({ ok: true });
      const noteOf = (h: typeof a) =>
        t.series.stored(market, { offerId: h.offerId, variantId: h.variantId })?.regular[1]
          ?.decision?.note;
      expect(noteOf(a)).toBeNull();
      expect(noteOf(b)).toHaveLength(1000);
    });

    it('refuses a foreign record and the submitter', async () => {
      const t = setup();
      const h = await t.held();
      expect(
        await t.reject.execute(t.admin(foreign), { recordId: h.recordId, reasonCode: 'other' }),
      ).toEqual({ ok: false, error: { code: 'pricing.hold.not-found' } });
      expect(
        await t.reject.execute(t.admin(market, h.accountId), {
          recordId: h.recordId,
          reasonCode: 'other',
        }),
      ).toEqual({ ok: false, error: { code: 'pricing.hold.own-submission' } });
    });
  });

  describe('pricing.list-price-holds and pricing.view-price-hold', () => {
    it('lists oldest first in this Market only, pages by cursor, and shows no submitter', async () => {
      const t = setup();
      const a = await t.held();
      const b = await t.held();
      const c = await t.held();
      await t.held(foreign);

      const first = await t.list.execute(t.admin(), { after: null, limit: 2 });
      expect(first).toMatchObject({ ok: true });
      if (!first.ok) return;
      expect(first.value.items.map((i) => i.recordId)).toEqual([a.recordId, b.recordId]);
      expect(first.value.next).not.toBeNull();
      const second = await t.list.execute(t.admin(), { after: first.value.next, limit: 2 });
      expect(second).toMatchObject({ ok: true, value: { next: null } });
      if (!second.ok) return;
      expect(second.value.items.map((i) => i.recordId)).toEqual([c.recordId]);
      const row = first.value.items[0]!;
      expect(Object.keys(row).sort()).toEqual([
        'amount',
        'anchorAmount',
        'anchorRecordId',
        'direction',
        'offerId',
        'recordId',
        'sellerId',
        'seriesId',
        'submittedAt',
        'variantId',
      ]);
    });

    it('refuses a bad cursor and a bad page size', async () => {
      const t = setup();
      expect(await t.list.execute(t.admin(), { after: 'nope', limit: 0 })).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [
            { path: 'after', code: 'format' },
            { path: 'limit', code: 'range' },
          ],
        },
      });
    });

    it('views one held record and answers a foreign or decided one as not found', async () => {
      const t = setup();
      const h = await t.held();
      expect(await t.view.execute(t.admin(), { recordId: h.recordId })).toMatchObject({
        ok: true,
        value: { recordId: h.recordId, direction: 'up' },
      });
      expect(await t.view.execute(t.admin(foreign), { recordId: h.recordId })).toEqual({
        ok: false,
        error: { code: 'pricing.hold.not-found' },
      });
      await t.reject.execute(t.admin(), { recordId: h.recordId, reasonCode: 'other' });
      expect(await t.view.execute(t.admin(), { recordId: h.recordId })).toEqual({
        ok: false,
        error: { code: 'pricing.hold.not-found' },
      });
    });

    it('opens read-only units', async () => {
      const t = setup();
      t.unitOfWork.units.length = 0;
      await t.list.execute(t.admin(), { after: null, limit: null });
      expect(t.unitOfWork.units.map((u) => u.options)).toEqual([{ readOnly: true }]);
    });
  });

  describe('the retirement handlers', () => {
    it('retire the series of a deleted Offer in a serializable once-unit, once', async () => {
      const t = setup();
      const h = await t.held();
      t.audit.rows.length = 0;
      t.outbox.events.length = 0;
      const delivery = t.delivery('pricing.retire-series-for-removed-offer');

      const first = await t.retireOffer.execute(t.system(), { delivery, offerId: h.offerId });
      expect(first).toEqual({
        ok: true,
        value: { code: 'pricing.series-retired', series: 1, superseded: 1 },
      });
      expect(t.unitOfWork.onceUnits.map((u) => u.options.isolation)).toEqual(['serializable']);
      const stored = t.series.stored(market, { offerId: h.offerId, variantId: h.variantId });
      expect(stored).toMatchObject({ retireCause: 'offer-removed' });
      expect(stored?.regular[1]).toMatchObject({
        status: 'SUPERSEDED',
        supersedeCause: 'offer-removed',
      });
      expect(t.outbox.events.map((e) => [e.type, e.aggregateVersion])).toEqual([
        ['pricing.price-hold-decided.v1', 4],
        ['pricing.effective-price-changed.v1', 5],
      ]);
      expect(t.outbox.events.map((e) => e.payload['outcome'] ?? e.payload['cause'])).toEqual([
        'superseded',
        'series-retired',
      ]);
      expect(t.audit.rows.map((r) => [r.action, r.actorKind])).toEqual([
        ['pricing.regular-price.superseded', 'system'],
        ['pricing.series.retired', 'system'],
      ]);
      expect(t.tombstones.offers.map((o) => o.offerId)).toEqual([h.offerId]);

      // The same delivery is a no-op; another event finds the series retired.
      expect(await t.retireOffer.execute(t.system(), { delivery, offerId: h.offerId })).toEqual({
        ok: true,
        value: { code: 'pricing.retire.already-handled' },
      });
      expect(
        await t.retireOffer.execute(t.system(), {
          delivery: t.delivery('pricing.retire-series-for-removed-offer'),
          offerId: h.offerId,
        }),
      ).toEqual({ ok: true, value: { code: 'pricing.series-retired', series: 0, superseded: 0 } });
      expect(t.outbox.events).toHaveLength(2);
      expect(t.tombstones.offers).toHaveLength(1);
    });

    it('record the tombstone with no series, so a later first price is refused', async () => {
      const t = setup();
      const sellerId = t.ids.next<'Seller'>();
      const offerId = t.ids.next<'Offer'>();
      const variantId = t.ids.next<'Variant'>();
      const productId = t.ids.next<'Product'>();
      t.offers.put(market, offerId, {
        sellerId,
        productId,
        deleted: false,
        priceableVariantIds: [variantId],
      });
      await t.retireOffer.execute(t.system(), {
        delivery: t.delivery('pricing.retire-series-for-removed-offer'),
        offerId,
      });
      expect(t.tombstones.offers).toHaveLength(1);

      const context = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: t.ids.next<'Account'>(),
          sessionId: t.ids.next<'Session'>(),
          sellerId,
        }),
      );
      const result = await t.set.execute(context, {
        offerId,
        variantId,
        price: { amount: fixture.base.toString(), currency: fixture.currency },
        expectedVersion: null,
      });
      expect(result).toEqual({ ok: false, error: { code: 'pricing.offer-not-found' } });
      expect(t.series.stored(market, { offerId, variantId })).toBeNull();
    });

    it('retire a removed Variant by (product, Variant) and record its tombstone', async () => {
      const t = setup();
      const h = await t.held();
      const other = await t.held();
      const result = await t.retireVariant.execute(t.system(), {
        delivery: t.delivery('pricing.retire-series-for-removed-variant'),
        productId: h.productId,
        variantId: h.variantId,
      });
      expect(result).toEqual({
        ok: true,
        value: { code: 'pricing.series-retired', series: 1, superseded: 1 },
      });
      expect(
        t.series.stored(market, { offerId: h.offerId, variantId: h.variantId })?.retireCause,
      ).toBe('variant-removed');
      expect(
        t.series.stored(market, { offerId: other.offerId, variantId: other.variantId })?.retiredAt,
      ).toBeNull();
      expect(t.tombstones.variants).toEqual([
        expect.objectContaining({ productId: h.productId, variantId: h.variantId }),
      ]);
    });

    it("read the context's Market only", async () => {
      const t = setup();
      const h = await t.held();
      const result = await t.retireOffer.execute(t.system(foreign), {
        delivery: t.delivery('pricing.retire-series-for-removed-offer'),
        offerId: h.offerId,
      });
      expect(result).toEqual({
        ok: true,
        value: { code: 'pricing.series-retired', series: 0, superseded: 0 },
      });
      expect(
        t.series.stored(market, { offerId: h.offerId, variantId: h.variantId })?.retiredAt,
      ).toBeNull();
    });

    it('refuse a caller that is not the system actor, and record nothing', async () => {
      const t = setup();
      const h = await t.held();
      const result = await t.retireOffer.execute(t.admin(), {
        delivery: t.delivery('pricing.retire-series-for-removed-offer'),
        offerId: h.offerId,
      });
      expect(result.ok).toBe(false);
      expect(t.tombstones.offers).toHaveLength(0);
      expect(
        t.series.stored(market, { offerId: h.offerId, variantId: h.variantId })?.retiredAt,
      ).toBeNull();
    });
  });
});
