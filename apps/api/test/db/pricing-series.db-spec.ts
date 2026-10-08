import { ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { PrismaPriceSeriesRepository } from '../../src/modules/pricing/infrastructure/prisma-price-series.repository';
import { PrismaRetirementTombstoneRepository } from '../../src/modules/pricing/infrastructure/prisma-retirement-tombstone.repository';
import {
  runSerializable,
  SerializableUnitRequiredError,
} from '../../src/modules/pricing/application/serializable-unit';
import { PriceSeries } from '../../src/modules/pricing/domain/price-series';
import type { PriceSeriesState } from '../../src/modules/pricing/domain/price-series';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import type { UnitOfWorkOptions } from '../../src/platform/unit-of-work/unit-of-work';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { PRICING_FIXTURES, amountOf } from '../support/pricing-fixtures';
import type { PricingMarketFixture } from '../support/pricing-fixtures';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  gate,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Pricing slice 1, part 2 on PostgreSQL (pricing-data 3.2, 3.3, 3.6, 5.1, P7, P10), for both
// Market fixtures (AU in AUD, the synthetic ZZ in JPY with exponent 0): the aggregate's round
// trip through the repository, optimistic saving, the creation race, the retirement tombstones
// and the write skew they close under SERIALIZABLE.

const fixtureOf = (code: string): PricingMarketFixture =>
  PRICING_FIXTURES.find((f) => f.code === code) as PricingMarketFixture;

/** A state as plain data, records by id, for comparing a round trip. */
function plain(state: PriceSeriesState): unknown {
  return JSON.parse(
    JSON.stringify(
      { ...state, regular: [...state.regular].sort((a, b) => (a.id < b.id ? -1 : 1)) },
      (_key, value: unknown) => (typeof value === 'bigint' ? `${value}n` : value),
    ),
  );
}

describe.each(TEST_MARKETS)('pricing price series in market %s (database integration)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const fixture = fixtureOf(code);
  const { policy } = fixture;
  const clock = new FixedClock(Temporal.Instant.from('2026-10-08T10:00:00Z'));
  const ids = new UuidV7IdGenerator(clock);
  const account = ids.next<'Account'>();
  const heldUp = (base: bigint): bigint =>
    (base * (policy.thresholdDenominator + policy.thresholdNumerator)) /
      policy.thresholdDenominator +
    1n;
  let persistence: Persistence;
  let series: PrismaPriceSeriesRepository;
  let tombstones: PrismaRetirementTombstoneRepository;
  let sql: Client;

  beforeAll(async () => {
    persistence = createPersistence({ pause: () => Promise.resolve() });
    series = new PrismaPriceSeriesRepository(persistence.service);
    tombstones = new PrismaRetirementTombstoneRepository(persistence.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await sql.end();
    await persistence.close();
  });

  const inUnit = <T>(
    work: () => Promise<T>,
    options?: UnitOfWorkOptions,
    target: MarketContext = market,
  ): Promise<T> =>
    // A serializable unit is opened the way pricing opens one: through runSerializable, the only
    // unit in which `add` runs (Hassan M1).
    (options?.isolation === 'serializable'
      ? runSerializable(persistence.unitOfWork, target, async () => ok(await work()))
      : persistence.unitOfWork.run(target, async () => ok(await work()), options)
    ).then((result) => {
      if (!result.ok) throw new Error('unit failed');
      return result.value;
    });
  const serializable: UnitOfWorkOptions = { isolation: 'serializable' };
  const advance = (ms: number) => clock.set(clock.now().add({ milliseconds: ms }));

  function created(
    keys: Partial<Pick<PriceSeriesState, 'offerId' | 'variantId' | 'productId'>> = {},
  ) {
    return PriceSeries.create({
      id: ids.next<'PriceSeries'>(),
      marketId: market.marketId,
      offerId: keys.offerId ?? ids.next<'Offer'>(),
      variantId: keys.variantId ?? ids.next<'Variant'>(),
      productId: keys.productId ?? ids.next<'Product'>(),
      sellerId: ids.next<'Seller'>(),
      currency: policy.currency,
      now: clock.now(),
    });
  }
  function set(target: PriceSeries, minor: bigint) {
    const result = target.setRegularPrice({
      recordId: ids.next<'RegularPriceRecord'>(),
      amount: amountOf(fixture, minor),
      submittedBy: account,
      taxInclusive: fixture.taxInclusive,
      now: clock.now(),
      policy,
    });
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  }
  const load = (target: PriceSeries) =>
    inUnit(() =>
      series.findByKey(market, {
        offerId: target.state.offerId,
        variantId: target.state.variantId,
      }),
    );

  it('stores a first price with its series at version 1 then 2, and reads it back unchanged', async () => {
    const fresh = created();
    set(fresh, fixture.base);

    expect(await inUnit(() => series.add(market, fresh), serializable)).toBe('added');
    expect(fresh.persistedVersion).toBe(2);

    const loaded = await load(fresh);
    expect(loaded).not.toBeNull();
    expect(plain(loaded!.state)).toEqual(plain(fresh.state));
    expect(loaded!.persistedVersion).toBe(2);
    const { rows } = await sql.query(
      `SELECT s.currency, version, tax_inclusive, status, amount_minor::text AS amount
         FROM pricing.price_series s JOIN pricing.regular_price_records r
           ON r.market_id = s.market_id AND r.series_id = s.id
        WHERE s.market_id = $1 AND s.id = $2`,
      [code, fresh.state.id],
    );
    expect(rows).toEqual([
      {
        currency: policy.currency,
        version: 2,
        tax_inclusive: fixture.taxInclusive,
        status: 'accepted',
        amount: `${fixture.base}`,
      },
    ]);
  });

  it('round-trips a history: accepted, held, replaced, cancelled, retired (P7 order)', async () => {
    const fresh = created();
    set(fresh, fixture.base);
    await inUnit(() => series.add(market, fresh), serializable);

    const steps: ((s: PriceSeries) => void)[] = [
      (s) => set(s, fixture.base + 1n), // accepted: closes the first period
      (s) => set(s, heldUp(fixture.base + 1n)), // held
      (s) => set(s, heldUp(fixture.base + 1n) + 1n), // held again: replaces the pending one
      (s) => set(s, fixture.base + 1n), // equal to the price in force: cancels the pending one
      (s) => set(s, heldUp(fixture.base + 1n)), // held
      (s) => s.retire('offer-removed', clock.now()), // retired: supersedes the pending one
    ];
    let expected = fresh.state;
    for (const step of steps) {
      advance(1000);
      const current = (await load(fresh))!;
      step(current);
      await inUnit(() => series.save(market, current));
      expected = current.state;
      expect(plain((await load(fresh))!.state)).toEqual(plain(expected));
    }

    const { rows } = await sql.query<{ status: string; supersede_cause: string | null }>(
      `SELECT status, supersede_cause FROM pricing.regular_price_records
        WHERE market_id = $1 AND series_id = $2 ORDER BY submitted_at, id`,
      [code, fresh.state.id],
    );
    expect(rows).toEqual([
      { status: 'accepted', supersede_cause: null },
      { status: 'accepted', supersede_cause: null },
      { status: 'superseded', supersede_cause: 'replaced' },
      { status: 'superseded', supersede_cause: 'cancelled' },
      { status: 'superseded', supersede_cause: 'offer-removed' },
    ]);
    // One version per event (P 10, part 3b): the replacing hold records two (superseded, opened).
    expect(expected).toMatchObject({ retireCause: 'offer-removed', version: 9 });
  });

  it('keeps the anchor copies equal to the records they name (Hassan, pricing-data review, Low)', async () => {
    const fresh = created();
    set(fresh, fixture.base);
    advance(1000);
    set(fresh, fixture.base + 2n);
    advance(1000);
    set(fresh, heldUp(fixture.base));
    await inUnit(() => series.add(market, fresh), serializable);

    const { rows } = await sql.query<{ measured: string; mismatched: string }>(
      `SELECT count(*) FILTER (WHERE r.anchor_record_id IS NOT NULL) AS measured,
              count(*) FILTER (WHERE a.amount_minor IS DISTINCT FROM r.anchor_amount_minor
                                 AND r.anchor_record_id IS NOT NULL) AS mismatched
         FROM pricing.regular_price_records r
         LEFT JOIN pricing.regular_price_records a
           ON a.market_id = r.market_id AND a.series_id = r.series_id AND a.id = r.anchor_record_id
        WHERE r.market_id = $1 AND r.series_id = $2`,
      [code, fresh.state.id],
    );
    expect(rows).toEqual([{ measured: '2', mismatched: '0' }]);
  });

  it('refuses a save over a version that changed since the load, and writes nothing (conflict.stale)', async () => {
    const fresh = created();
    set(fresh, fixture.base);
    await inUnit(() => series.add(market, fresh), serializable);
    const first = (await load(fresh))!;
    const second = (await load(fresh))!;
    advance(1000);
    set(first, fixture.base + 1n);
    set(second, fixture.base + 2n);
    await inUnit(() => series.save(market, first));

    await expect(inUnit(() => series.save(market, second))).rejects.toBeInstanceOf(
      StaleAggregateError,
    );
    expect(plain((await load(fresh))!.state)).toEqual(plain(first.state));
  });

  it('refuses a second series for a key (the creation race) and refuses save of a new series', async () => {
    const one = created();
    const two = created({ offerId: one.state.offerId, variantId: one.state.variantId });
    await inUnit(() => series.add(market, one), serializable);

    await expect(inUnit(() => series.add(market, two), serializable)).rejects.toBeInstanceOf(
      StaleAggregateError,
    );
    await expect(inUnit(() => series.save(market, created()))).rejects.toThrow('use add');
    await expect(inUnit(() => series.add(market, one), serializable)).rejects.toThrow('use save');
  });

  it("finds no other Market's series, and lets the same key live once in each Market", async () => {
    const here = created();
    await inUnit(() => series.add(market, here), serializable);
    const key = { offerId: here.state.offerId, variantId: here.state.variantId };

    expect(await inUnit(() => series.findByKey(other, key), undefined, other)).toBeNull();
    const there = PriceSeries.create({
      ...here.state,
      id: ids.next<'PriceSeries'>(),
      marketId: other.marketId,
      currency: fixtureOf(other.marketId).policy.currency,
      now: clock.now(),
    });
    expect(await inUnit(() => series.add(other, there), serializable, other)).toBe('added');
    expect((await inUnit(() => series.findByKey(other, key), undefined, other))?.state.id).toBe(
      there.state.id,
    );
    const stray = PriceSeries.create({
      ...there.state,
      id: ids.next<'PriceSeries'>(),
      now: clock.now(),
    });
    await expect(inUnit(() => series.add(market, stray), serializable)).rejects.toThrow(
      'another Market',
    );
  });

  it('finds the series of an Offer and of a (product, Variant) for the retirement handlers', async () => {
    const offerId = ids.next<'Offer'>();
    const productId = ids.next<'Product'>();
    const a = created({ offerId, productId });
    const b = created({ offerId, productId });
    await inUnit(() => series.add(market, a), serializable);
    await inUnit(() => series.add(market, b), serializable);

    const byOffer = await inUnit(() => series.findByOffer(market, offerId));
    const byVariant = await inUnit(() =>
      series.findByProductVariant(market, productId, b.state.variantId),
    );
    expect(byOffer.map((s) => s.state.id).sort()).toEqual([a.state.id, b.state.id].sort());
    expect(byVariant.map((s) => s.state.id)).toEqual([b.state.id]);
  });

  describe('retirement tombstones (pricing-data 3.6; Hassan finding 3)', () => {
    it('records each tombstone once: skipDuplicates reports the inserted count (spike S1 d)', async () => {
      const offerId = ids.next<'Offer'>();
      const tombstone = { offerId, retiredAt: clock.now(), causeEventId: ids.next<'Event'>() };
      const variant = {
        productId: ids.next<'Product'>(),
        variantId: ids.next<'Variant'>(),
        retiredAt: clock.now(),
        causeEventId: ids.next<'Event'>(),
      };

      expect(await inUnit(() => tombstones.recordRetiredOffer(market, tombstone))).toBe(true);
      expect(await inUnit(() => tombstones.recordRetiredOffer(market, tombstone))).toBe(false);
      expect(await inUnit(() => tombstones.recordRetiredVariant(market, variant))).toBe(true);
      expect(await inUnit(() => tombstones.recordRetiredVariant(market, variant))).toBe(false);
      // The same ids in the other Market are another tombstone.
      expect(
        await inUnit(() => tombstones.recordRetiredOffer(other, tombstone), undefined, other),
      ).toBe(true);
    });

    it('creates no series for a retired Offer or a retired (product, Variant), and writes nothing', async () => {
      const offerGone = created();
      await inUnit(() =>
        tombstones.recordRetiredOffer(market, {
          offerId: offerGone.state.offerId,
          retiredAt: clock.now(),
          causeEventId: ids.next<'Event'>(),
        }),
      );
      const variantGone = created();
      await inUnit(() =>
        tombstones.recordRetiredVariant(market, {
          productId: variantGone.state.productId,
          variantId: variantGone.state.variantId,
          retiredAt: clock.now(),
          causeEventId: ids.next<'Event'>(),
        }),
      );
      set(offerGone, fixture.base);

      expect(await inUnit(() => series.add(market, offerGone), serializable)).toBe('key-retired');
      expect(await inUnit(() => series.add(market, variantGone), serializable)).toBe('key-retired');
      const { rows } = await sql.query(
        `SELECT 1 FROM pricing.price_series WHERE market_id = $1 AND id = ANY($2::uuid[])`,
        [code, [offerGone.state.id, variantGone.state.id]],
      );
      expect(rows).toEqual([]);
    });

    it('leaves no live series after a tombstone when a first price races the retirement (5.1)', async () => {
      const fresh = created();
      const { offerId, variantId, productId, sellerId } = fresh.state;
      const creatorWrote = gate();
      const handlerDone = gate();
      let attempts = 0;

      // The creator reads both tombstones (none) and inserts, then waits for the handler to
      // commit before it commits itself. Every retry rebuilds the series (P 3.1 row 5).
      const creator = runSerializable(persistence.unitOfWork, market, async () => {
        attempts += 1;
        const attempt = PriceSeries.create({
          id: ids.next<'PriceSeries'>(),
          marketId: market.marketId,
          offerId,
          variantId,
          productId,
          sellerId,
          currency: policy.currency,
          now: clock.now(),
        });
        set(attempt, fixture.base);
        const outcome = await series.add(market, attempt);
        if (attempts === 1) {
          creatorWrote.open();
          await handlerDone.opened;
        }
        return ok(outcome);
      });
      await creatorWrote.opened;
      // The Offer-removed handler: the tombstone, then every live series of the Offer retired.
      await inUnit(async () => {
        await tombstones.recordRetiredOffer(market, {
          offerId,
          retiredAt: clock.now(),
          causeEventId: ids.next<'Event'>(),
        });
        for (const found of await series.findByOffer(market, offerId)) {
          found.retire('offer-removed', clock.now());
          await series.save(market, found);
        }
      }, serializable).finally(() => handlerDone.open());
      const outcome = await creator;

      const { rows } = await sql.query(
        `SELECT 1 FROM pricing.price_series
          WHERE market_id = $1 AND offer_id = $2 AND retired_at IS NULL`,
        [code, offerId],
      );
      expect(rows).toEqual([]);
      expect(outcome).toEqual({ ok: true, value: 'key-retired' });
      expect(attempts).toBe(2);
    });
  });

  describe('add fails closed outside a serializable unit (design 19 condition (a); Hassan M1)', () => {
    it('refuses add in a READ COMMITTED unit and in a serializable unit not opened by runSerializable', async () => {
      const fresh = created();
      set(fresh, fixture.base);

      await expect(inUnit(() => series.add(market, fresh))).rejects.toBeInstanceOf(
        SerializableUnitRequiredError,
      );
      await expect(
        persistence.unitOfWork.run(market, async () => ok(await series.add(market, fresh)), {
          isolation: 'serializable',
        }),
      ).rejects.toBeInstanceOf(SerializableUnitRequiredError);
      await expect(series.add(market, fresh)).rejects.toBeInstanceOf(SerializableUnitRequiredError);
      const { rows } = await sql.query(
        `SELECT 1 FROM pricing.price_series WHERE market_id = $1 AND id = $2`,
        [code, fresh.state.id],
      );
      expect(rows).toEqual([]);
      expect(await inUnit(() => series.add(market, fresh), serializable)).toBe('added');
    });

    it('leaves no live series after a Variant tombstone when a first price races the Variant-removed handler', async () => {
      const fresh = created();
      const { offerId, variantId, productId, sellerId } = fresh.state;
      const creatorWrote = gate();
      const handlerDone = gate();
      let attempts = 0;

      const creator = runSerializable(persistence.unitOfWork, market, async () => {
        attempts += 1;
        const attempt = PriceSeries.create({
          id: ids.next<'PriceSeries'>(),
          marketId: market.marketId,
          offerId,
          variantId,
          productId,
          sellerId,
          currency: policy.currency,
          now: clock.now(),
        });
        set(attempt, fixture.base);
        const outcome = await series.add(market, attempt);
        if (attempts === 1) {
          creatorWrote.open();
          await handlerDone.opened;
        }
        return ok(outcome);
      });
      await creatorWrote.opened;
      // The Variant-removed handler: the (product, Variant) tombstone, then its live series.
      await inUnit(async () => {
        await tombstones.recordRetiredVariant(market, {
          productId,
          variantId,
          retiredAt: clock.now(),
          causeEventId: ids.next<'Event'>(),
        });
        for (const found of await series.findByProductVariant(market, productId, variantId)) {
          found.retire('variant-removed', clock.now());
          await series.save(market, found);
        }
      }, serializable).finally(() => handlerDone.open());
      const outcome = await creator;

      const { rows } = await sql.query(
        `SELECT 1 FROM pricing.price_series
          WHERE market_id = $1 AND product_id = $2 AND variant_id = $3 AND retired_at IS NULL`,
        [code, productId, variantId],
      );
      expect(rows).toEqual([]);
      expect(outcome).toEqual({ ok: true, value: 'key-retired' });
      expect(attempts).toBe(2);
    });
  });

  it('never uses a series id as a key of another series (the id is a primary key)', async () => {
    const one = created();
    await inUnit(() => series.add(market, one), serializable);
    const clash = PriceSeries.create({
      ...one.state,
      offerId: ids.next<'Offer'>(),
      now: clock.now(),
    });
    await expect(inUnit(() => series.add(market, clash), serializable)).rejects.toBeInstanceOf(
      StaleAggregateError,
    );
  });
});
