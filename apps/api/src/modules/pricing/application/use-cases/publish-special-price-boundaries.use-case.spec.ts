import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
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
import {
  BOUNDARY_BATCH_SIZE,
  BOUNDARY_HORIZON_MS,
  PublishSpecialPriceBoundaries,
} from './publish-special-price-boundaries.use-case';
import { SetRegularPrice } from './set-regular-price.use-case';
import { SetSpecialPrice } from './set-special-price.use-case';
import { WithdrawSpecialPrice } from './withdraw-special-price.use-case';

// `pricing.publish-special-price-boundaries` in memory (pricing design 11, data design 3.5), on
// both Market fixtures: system actor only; one marker per boundary, written first; a repeated run
// announces nothing twice; a boundary older than the horizon is never announced; prices are
// untouched. The marker and index behaviour in PostgreSQL is in
// test/db/pricing-special-price.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const policies = new ConfigPricingPolicyProvider(markets);

const FIXTURES = {
  AU: { currency: 'AUD', base: 10_000n, special: 9_000n },
  ZZ: { currency: 'JPY', base: 1_000n, special: 900n },
} as const;

const HOUR = 3_600_000;
const T0 = Temporal.Instant.from('2026-10-08T10:00:00Z');

describe.each(['AU', 'ZZ'] as const)(
  'pricing.publish-special-price-boundaries in market %s',
  (code) => {
    const fixture = FIXTURES[code];
    const market = testMarketContext(code, 'default');
    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());

    async function setup() {
      const clock = new FixedClock(T0);
      const ids = new SequenceIdGenerator(clock);
      const unitOfWork = new FakeUnitOfWork();
      const series = new InMemoryPriceSeries();
      const offers = new FakeOfferSellUnits();
      const outbox = new RecordingOutbox();
      const deps = {
        unitOfWork,
        series,
        throttles: new InMemoryRefusalThrottles(),
        counters: new InMemoryWriteRateCounters(),
        offers,
        audit: new RecordingAuditWriter(),
        outbox,
        clock,
      };
      const setRegular = new SetRegularPrice(gate, { ...deps, policies, ids });
      const setSpecial = new SetSpecialPrice(gate, { ...deps, policies, ids });
      const withdraw = new WithdrawSpecialPrice(gate, deps);
      const publish = new PublishSpecialPriceBoundaries(gate, {
        unitOfWork,
        series,
        outbox,
        clock,
      });
      const sellerId = ids.next<'Seller'>();
      const accountId = ids.next<'Account'>();
      const seller = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId,
          sessionId: ids.next<'Session'>(),
          sellerId,
        }),
      );
      const system = testCallContext(market, 'system');
      const offerId = ids.next<'Offer'>();
      const variantId = ids.next<'Variant'>();
      offers.put(market, offerId, {
        sellerId,
        productId: ids.next<'Product'>(),
        deleted: false,
        priceableVariantIds: [variantId],
      });
      const key = { offerId, variantId };
      const version = () => series.stored(market, key)!.version;
      const regular = await setRegular.execute(seller, {
        offerId,
        variantId,
        price: { amount: fixture.base.toString(), currency: fixture.currency },
        expectedVersion: null,
      });
      if (!regular.ok) throw new Error('setup');
      const special = async (startsAt: Temporal.Instant | null, endsAt: Temporal.Instant) => {
        const written = await setSpecial.execute(seller, {
          offerId,
          variantId,
          price: { amount: fixture.special.toString(), currency: fixture.currency },
          startsAt: startsAt?.toString() ?? null,
          endsAt: endsAt.toString(),
          expectedVersion: version(),
        });
        if (!written.ok) throw new Error(JSON.stringify(written.error));
        return written.value;
      };
      const at = (instant: Temporal.Instant) => clock.set(instant);
      const causes = () => outbox.events.map((event) => (event.payload as { cause: string }).cause);
      return {
        clock,
        series,
        outbox,
        unitOfWork,
        publish,
        system,
        seller,
        withdraw,
        key,
        version,
        special,
        at,
        causes,
        offerId,
        variantId,
      };
    }

    it('declares the system rule and refuses any other actor without a unit', async () => {
      expect(PublishSpecialPriceBoundaries.access).toEqual({
        name: 'pricing.publish-special-price-boundaries',
        rule: { kind: 'system' },
      });
      const t = await setup();
      t.unitOfWork.units.length = 0;
      expect((await t.publish.execute(t.seller, {})).ok).toBe(false);
      expect(t.unitOfWork.units).toEqual([]);
    });

    it('announces a scheduled special start and its end, once each, and never twice', async () => {
      const t = await setup();
      const startsAt = T0.add({ milliseconds: 2 * HOUR });
      const endsAt = T0.add({ milliseconds: 5 * HOUR });
      await t.special(startsAt, endsAt);
      t.outbox.events.length = 0;

      // Before the start: nothing is due.
      t.at(T0.add({ milliseconds: HOUR }));
      expect(await t.publish.execute(t.system, {})).toEqual({
        ok: true,
        value: { announced: 0, skipped: 0, alreadyMarked: 0, failed: 0 },
      });

      t.at(startsAt.add({ milliseconds: 60_000 }));
      const before = t.version();
      expect(await t.publish.execute(t.system, {})).toEqual({
        ok: true,
        value: { announced: 1, skipped: 0, alreadyMarked: 0, failed: 0 },
      });
      expect(t.causes()).toEqual(['special-started']);
      expect(t.version()).toBe(before + 1);
      // A repeated run finds the marker and does nothing: no version step, no second event.
      expect((await t.publish.execute(t.system, {})).ok).toBe(true);
      expect(t.causes()).toEqual(['special-started']);
      expect(t.version()).toBe(before + 1);

      t.at(endsAt.add({ milliseconds: 60_000 }));
      expect(await t.publish.execute(t.system, {})).toEqual({
        ok: true,
        value: { announced: 1, skipped: 0, alreadyMarked: 0, failed: 0 },
      });
      expect(t.causes()).toEqual(['special-started', 'special-ended']);
      expect(t.version()).toBe(before + 2);
    });

    it('a concurrent run that lost the marker race announces nothing', async () => {
      const t = await setup();
      const endsAt = T0.add({ milliseconds: 3 * HOUR });
      await t.special(null, endsAt);
      t.outbox.events.length = 0;
      t.at(endsAt.add({ milliseconds: 1000 }));
      // The other run marked the immediate start and the end between our read and our unit.
      const due = await t.series.listDueSpecialBoundaries(
        market,
        t.clock.now(),
        BOUNDARY_HORIZON_MS,
        10,
      );
      expect(due.map((d) => d.boundary).sort()).toEqual(['end', 'start']);
      for (const d of due)
        await t.series.markSpecialBoundary(market, d.recordId, d.boundary, t.clock.now());
      const version = t.version();
      expect(await t.publish.execute(t.system, {})).toEqual({
        ok: true,
        value: { announced: 0, skipped: 0, alreadyMarked: 0, failed: 0 },
      });
      expect(t.version()).toBe(version);
      expect(t.outbox.events).toEqual([]);
    });

    it('marks, without an event, a start of a special withdrawn before it began', async () => {
      const t = await setup();
      const startsAt = T0.add({ milliseconds: 4 * HOUR });
      await t.special(startsAt, T0.add({ milliseconds: 8 * HOUR }));
      t.at(T0.add({ milliseconds: HOUR }));
      const withdrawn = await t.withdraw.execute(t.seller, {
        offerId: t.offerId,
        variantId: t.variantId,
        expectedVersion: t.version(),
      });
      expect(withdrawn.ok).toBe(true);
      t.outbox.events.length = 0;
      t.at(T0.add({ milliseconds: 10 * HOUR }));
      const version = t.version();
      const result = await t.publish.execute(t.system, {});
      // Its start is found (it has a start instant) and marked, but there is nothing to tell.
      expect(result).toEqual({
        ok: true,
        value: { announced: 0, skipped: 1, alreadyMarked: 0, failed: 0 },
      });
      expect(t.version()).toBe(version);
      expect(t.outbox.events).toEqual([]);
    });

    it('does not announce a boundary older than the horizon', async () => {
      const t = await setup();
      const endsAt = T0.add({ milliseconds: 3 * HOUR });
      await t.special(null, endsAt);
      t.outbox.events.length = 0;
      t.at(endsAt.add({ milliseconds: BOUNDARY_HORIZON_MS + 1000 }));
      const version = t.version();
      expect(await t.publish.execute(t.system, {})).toEqual({
        ok: true,
        value: { announced: 0, skipped: 0, alreadyMarked: 0, failed: 0 },
      });
      expect(t.version()).toBe(version);
    });

    it('takes at most one batch per run, oldest boundary first', async () => {
      const t = await setup();
      await t.special(null, T0.add({ milliseconds: 2 * HOUR }));
      t.at(T0.add({ milliseconds: 3 * HOUR }));
      const due = await t.series.listDueSpecialBoundaries(
        market,
        t.clock.now(),
        BOUNDARY_HORIZON_MS,
        1,
      );
      expect(due).toHaveLength(1);
      expect(due[0]?.boundary).toBe('start');
      expect(BOUNDARY_BATCH_SIZE).toBe(100);
    });

    it('counts a failed unit and goes on; the boundary is found again next run', async () => {
      const t = await setup();
      const endsAt = T0.add({ milliseconds: 3 * HOUR });
      await t.special(null, endsAt);
      t.outbox.events.length = 0;
      t.at(endsAt.add({ milliseconds: 1000 }));
      const save = jest.spyOn(t.series, 'save').mockRejectedValueOnce(new Error('stale'));
      const first = await t.publish.execute(t.system, {});
      // The start's unit failed and rolled its marker back; the end was announced.
      expect(first).toEqual({
        ok: true,
        value: { announced: 1, skipped: 0, alreadyMarked: 0, failed: 1 },
      });
      save.mockRestore();
    });
  },
);
