import { randomBytes } from 'node:crypto';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { FakeOfferSellUnits } from '../support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { REFUSAL_ROWS_PER_ACTOR } from '../../src/modules/pricing/application/refusals/offer-write-refusal';
import { PurgeWriteRefusalThrottles } from '../../src/modules/pricing/application/use-cases/purge-write-refusal-throttles.use-case';
import {
  SetRegularPrice,
  type SetRegularPriceInput,
} from '../../src/modules/pricing/application/use-cases/set-regular-price.use-case';
import { PRICING_AUDIT_ACTIONS } from '../../src/modules/pricing/domain/audit';
import { PRICING_EVENTS } from '../../src/modules/pricing/domain/events';
import { ConfigPricingPolicyProvider } from '../../src/modules/pricing/infrastructure/config-pricing-policy-provider';
import { PrismaPriceSeriesRepository } from '../../src/modules/pricing/infrastructure/prisma-price-series.repository';
import { PrismaRetirementTombstoneRepository } from '../../src/modules/pricing/infrastructure/prisma-retirement-tombstone.repository';
import { PrismaWriteRefusalThrottleRepository } from '../../src/modules/pricing/infrastructure/prisma-write-refusal-throttle.repository';
import { AuditActionCatalogue } from '../../src/platform/audit/audit-action-catalogue';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { PersistenceModule } from '../../src/platform/persistence/persistence.module';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import type { PriceSeriesRepository } from '../../src/modules/pricing/application/ports/price-series.repository';
import { runSerializable } from '../../src/modules/pricing/application/serializable-unit';
import {
  createPersistence,
  gate as openable,
  marketOf,
  modelMap,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// `pricing.set-regular-price` on PostgreSQL (pricing design 5.2, 8, 9; pricing-data 3.8, 5.1;
// slice 1 part 3b), for both Market fixtures, with the real repositories, outbox writer and
// audit writer. catalog's answer is a fake: its production binding answers every Offer absent
// until catalog slice 7 (ADR-0031). Covers design 19 conditions (a), (b), (d), (e) and (g), and
// the part 2 carry-over "the counter and its audit row commit or roll back together" (M7).

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const policies = new ConfigPricingPolicyProvider(markets);

const BASE = { AU: { currency: 'AUD', base: 10_000n }, ZZ: { currency: 'JPY', base: 1_000n } };

describe.each(TEST_MARKETS)(
  'pricing.set-regular-price in market %s (database integration)',
  (code) => {
    const market: MarketContext = marketOf(code);
    const { currency, base } = BASE[code];
    const clock = new FixedClock(Temporal.Instant.from('2026-10-08T10:00:00Z'));
    const ids = new UuidV7IdGenerator(clock);
    let retries = 0;
    let persistence: Persistence;
    let sql: Client;
    let audit: AuditWriter;
    let offers: FakeOfferSellUnits;
    let throttles: PrismaWriteRefusalThrottleRepository;
    let tombstones: PrismaRetirementTombstoneRepository;

    beforeAll(async () => {
      persistence = createPersistence({
        pause: () => {
          retries += 1;
          return Promise.resolve();
        },
      });
      sql = new Client({ connectionString: testDatabaseUrl() });
      await sql.connect();
      const auditCatalogue = new AuditActionCatalogue();
      auditCatalogue.register('pricing', PRICING_AUDIT_ACTIONS);
      auditCatalogue.seal();
      audit = PersistenceModule.auditWriterFor('pricing').useFactory(
        auditCatalogue,
        ids,
        clock,
        NO_PERMISSION_KEYS,
      ) as AuditWriter;
      throttles = new PrismaWriteRefusalThrottleRepository(persistence.service);
      tombstones = new PrismaRetirementTombstoneRepository(persistence.service);
    });
    afterAll(async () => {
      await sql.end();
      await persistence.close();
    });
    beforeEach(() => {
      offers = new FakeOfferSellUnits();
      clock.set(Temporal.Instant.from('2026-10-08T10:00:00Z'));
    });

    function useCase(
      auditWriter: AuditWriter = audit,
      seriesRepository: PriceSeriesRepository = new PrismaPriceSeriesRepository(
        persistence.service,
      ),
    ): SetRegularPrice {
      const events = new EventCatalogue();
      events.register('pricing', PRICING_EVENTS);
      events.seal();
      return new SetRegularPrice(gate, {
        unitOfWork: persistence.unitOfWork,
        series: seriesRepository,
        throttles,
        offers,
        policies,
        audit: auditWriter,
        outbox: new PrismaOutboxWriterFactory(
          modelMap,
          persistence.service,
          events,
          ids,
          NO_PERMISSION_KEYS,
        ).forModule('pricing'),
        clock,
        ids,
      });
    }

    /** A seller with one Offer of one Variant, and a unique correlation id for its rows. */
    function seller() {
      const sellerId = ids.next<'Seller'>();
      const accountId = ids.next<'Account'>();
      const offerId = ids.next<'Offer'>();
      const variantId = ids.next<'Variant'>();
      const productId = ids.next<'Product'>();
      const correlationId = `pricing-db-${randomBytes(6).toString('hex')}`;
      const context: CallContext = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId,
          sessionId: ids.next<'Session'>(),
          sellerId,
        }),
        correlationId,
      );
      offers.put(market, offerId, {
        sellerId,
        productId,
        deleted: false,
        priceableVariantIds: [variantId],
      });
      const input = (amount: bigint, expectedVersion: number | null): SetRegularPriceInput => ({
        offerId,
        variantId,
        price: { amount: amount.toString(), currency },
        expectedVersion,
      });
      return { sellerId, accountId, offerId, variantId, productId, correlationId, context, input };
    }

    const auditRows = async (correlationId: string) =>
      (
        await sql.query<{
          action: string;
          actor_type: string;
          actor_id: string;
          target_id: string;
          after: unknown;
        }>(
          `SELECT action, actor_type, actor_id, target_id, after FROM platform.audit_log
          WHERE market_id = $1 AND correlation_id = $2 ORDER BY occurred_at, id`,
          [code, correlationId],
        )
      ).rows;

    it('writes a first price, its audit row and its event in one serializable unit; then a hold', async () => {
      const s = seller();
      const first = await useCase().execute(s.context, s.input(base, null));
      expect(first).toMatchObject({ ok: true, value: { status: 'accepted', seriesVersion: 2 } });

      const { rows: series } = await sql.query<{ id: string }>(
        `SELECT id, product_id, seller_id, currency, version FROM pricing.price_series
        WHERE market_id = $1 AND offer_id = $2 AND variant_id = $3`,
        [code, s.offerId, s.variantId],
      );
      expect(series).toEqual([
        {
          id: expect.any(String) as unknown,
          product_id: s.productId,
          seller_id: s.sellerId,
          currency,
          version: 2,
        },
      ]);
      clock.set(clock.now().add({ seconds: 5 }));
      const held = await useCase().execute(s.context, s.input(base * 4n, 2));
      expect(held).toMatchObject({
        ok: true,
        value: { status: 'pending-review', seriesVersion: 3 },
      });

      const { rows: events } = await sql.query<{
        type: string;
        aggregate_version: number;
        payload: unknown;
      }>(
        `SELECT type, aggregate_version, payload FROM pricing.outbox
        WHERE market_id = $1 AND aggregate_id = $2 ORDER BY aggregate_version`,
        [code, series[0]!.id],
      );
      expect(events.map((e) => [e.type, e.aggregate_version])).toEqual([
        ['pricing.effective-price-changed.v1', 2],
        ['pricing.price-hold-opened.v1', 3],
      ]);
      // No amount in any event (design 6.3).
      expect(JSON.stringify(events)).not.toContain((base * 4n).toString());
      const rows = await auditRows(s.correlationId);
      expect(rows.map((r) => [r.action, r.actor_type, r.actor_id, r.target_id])).toEqual([
        ['pricing.regular-price.accepted', 'USER', s.accountId, series[0]!.id],
        ['pricing.regular-price.held', 'USER', s.accountId, series[0]!.id],
      ]);
    });

    it("answers pricing.offer-not-found after a tombstone, with the cause in the audit row only (condition (d): the product id is catalog's)", async () => {
      const s = seller();
      await persistence.unitOfWork.run(market, async () =>
        ok(
          await tombstones.recordRetiredVariant(market, {
            productId: s.productId,
            variantId: s.variantId,
            retiredAt: clock.now(),
            causeEventId: ids.next<'Event'>(),
          }),
        ),
      );
      const result = await useCase().execute(s.context, s.input(base, null));

      expect(result).toEqual({ ok: false, error: { code: 'pricing.offer-not-found' } });
      const { rows } = await sql.query(
        'SELECT 1 FROM pricing.price_series WHERE market_id = $1 AND offer_id = $2',
        [code, s.offerId],
      );
      expect(rows).toEqual([]);
      expect(
        (await auditRows(s.correlationId)).map((r) => [r.action, r.target_id, r.after]),
      ).toEqual([
        [
          'pricing.offer-write.refused',
          s.offerId,
          { variantId: s.variantId, cause: 'key-retired' },
        ],
      ]);
    });

    it('commits a refusal counter with its audit row, and rolls both back together (M7)', async () => {
      const s = seller();
      const foreign = ids.next<'Offer'>();
      const failing: AuditWriter = {
        record: async (context, entry: AuditEntry) => {
          await audit.record(context, entry);
          throw new Error('audit row refused after it was written');
        },
      };
      await expect(
        useCase(failing).execute(s.context, { ...s.input(base, null), offerId: foreign }),
      ).rejects.toThrow('audit row refused');
      const counters = async () =>
        (
          await sql.query<{ actors: number; pairs: number }>(
            `SELECT (SELECT count(*) FROM pricing.write_refusal_actor_throttles
                    WHERE market_id = $1 AND actor_account_id = $2)::int AS actors,
                  (SELECT count(*) FROM pricing.write_refusal_throttles
                    WHERE market_id = $1 AND actor_account_id = $2)::int AS pairs`,
            [code, s.accountId],
          )
        ).rows[0];
      expect(await counters()).toEqual({ actors: 0, pairs: 0 });
      expect(await auditRows(s.correlationId)).toEqual([]);

      expect(
        await useCase().execute(s.context, { ...s.input(base, null), offerId: foreign }),
      ).toEqual({ ok: false, error: { code: 'pricing.offer-not-found' } });
      expect(await counters()).toEqual({ actors: 1, pairs: 1 });
      expect((await auditRows(s.correlationId)).map((r) => r.action)).toEqual([
        'pricing.offer-write.refused',
      ]);
    });

    it('caps an actor at 20 rows, then one summary row with the window start and no count (condition (g))', async () => {
      const s = seller();
      const start = clock.now();
      for (let i = 0; i < REFUSAL_ROWS_PER_ACTOR + 3; i += 1) {
        await useCase().execute(s.context, {
          ...s.input(base, null),
          offerId: ids.next<'Offer'>(),
        });
      }
      const rows = await auditRows(s.correlationId);
      expect(rows.filter((r) => r.action === 'pricing.offer-write.refused')).toHaveLength(
        REFUSAL_ROWS_PER_ACTOR,
      );
      expect(rows.filter((r) => r.action === 'pricing.offer-write.refusals-suppressed')).toEqual([
        expect.objectContaining({
          target_id: s.accountId,
          after: { windowStartedAt: start.toString({ fractionalSecondDigits: 3 }) },
        }),
      ]);
      // No (actor, Offer) row grows for a suppressed actor (condition (b)).
      const { rows: pairs } = await sql.query(
        'SELECT count(*)::int AS n FROM pricing.write_refusal_throttles WHERE market_id = $1 AND actor_account_id = $2',
        [code, s.accountId],
      );
      expect(pairs).toEqual([{ n: REFUSAL_ROWS_PER_ACTOR }]);
    });

    it('runs concurrent mixed refusals of one actor and the purge without a deadlock or a retry (conditions (b), (e))', async () => {
      const s = seller();
      const repeated = [ids.next<'Offer'>(), ids.next<'Offer'>(), ids.next<'Offer'>()];
      // An old window of this actor, so the purge has rows of both tables to take.
      await persistence.unitOfWork.run(market, async () =>
        ok(
          await throttles.admitRefusal(
            market,
            s.accountId,
            ids.next<'Offer'>(),
            clock.now().subtract({ hours: 2 }),
            60_000,
            REFUSAL_ROWS_PER_ACTOR,
          ),
        ),
      );
      const purge = new PurgeWriteRefusalThrottles(gate, {
        unitOfWork: persistence.unitOfWork,
        throttles,
        clock,
      });
      retries = 0;
      const calls = Array.from({ length: 30 }, (_, i) =>
        useCase().execute(s.context, {
          ...s.input(base, null),
          // Repeats on three Offers mixed with new Offers: refunds and fresh slots interleave.
          offerId: i % 2 === 0 ? repeated[i % 3]! : ids.next<'Offer'>(),
        }),
      );
      const purges = Array.from({ length: 3 }, () =>
        purge.execute(testCallContext(market, 'system'), {}),
      );
      const results = await Promise.all([...calls, ...purges]);

      expect(
        results.slice(0, 30).every((r) => !r.ok && r.error.code === 'pricing.offer-not-found'),
      ).toBe(true);
      expect(results.slice(30).every((r) => r.ok)).toBe(true);
      expect(retries).toBe(0);
      // recorded_count counts rows written in the window: repeats gave their slot back.
      const refused = (await auditRows(s.correlationId)).filter(
        (r) => r.action === 'pricing.offer-write.refused',
      );
      const { rows } = await sql.query(
        `SELECT recorded_count FROM pricing.write_refusal_actor_throttles
        WHERE market_id = $1 AND actor_account_id = $2`,
        [code, s.accountId],
      );
      expect(rows).toEqual([{ recorded_count: refused.length }]);
      expect(refused).toHaveLength(Math.min(REFUSAL_ROWS_PER_ACTOR, 3 + 15));
    });

    it('creates the series once when two first prices race; the loser answers conflict.stale', async () => {
      const s = seller();
      const results = await Promise.allSettled([
        useCase().execute(s.context, s.input(base, null)),
        useCase().execute(s.context, s.input(base + 1n, null)),
      ]);
      // The loser sees the winner's series on its retry (conflict.stale), or loses the unique key
      // (StaleAggregateError, which the HTTP filter answers as conflict.stale, P 10).
      const outcomes = results
        .map((r) => {
          if (r.status === 'rejected') {
            return r.reason instanceof StaleAggregateError ? 'conflict.stale' : String(r.reason);
          }
          return r.value.ok ? r.value.value.status : r.value.error.code;
        })
        .sort();
      expect(outcomes).toEqual(['accepted', 'conflict.stale']);
      const { rows } = await sql.query(
        'SELECT count(*)::int AS n FROM pricing.price_series WHERE market_id = $1 AND offer_id = $2',
        [code, s.offerId],
      );
      expect(rows).toEqual([{ n: 1 }]);
    });

    it('refuses an Offer that catalog knows only in the other Market: offer-not-found, cause absent, no series in either Market (Hassan I2)', async () => {
      const s = seller();
      const other = marketOf(otherMarketOf(code));
      // catalog answers per Market: this Offer exists only under the other Market.
      offers = new FakeOfferSellUnits();
      offers.put(other, s.offerId, {
        sellerId: s.sellerId,
        productId: s.productId,
        deleted: false,
        priceableVariantIds: [s.variantId],
      });

      expect(await useCase().execute(s.context, s.input(base, null))).toEqual({
        ok: false,
        error: { code: 'pricing.offer-not-found' },
      });
      const { rows } = await sql.query(
        'SELECT market_id FROM pricing.price_series WHERE offer_id = $1',
        [s.offerId],
      );
      expect(rows).toEqual([]);
      expect(
        (await auditRows(s.correlationId)).map((r) => [r.action, r.target_id, r.after]),
      ).toEqual([
        ['pricing.offer-write.refused', s.offerId, { variantId: s.variantId, cause: 'absent' }],
      ]);
    });

    it('answers key-retired when a first price races the Variant-removed tombstone: the retried creator finds it, no live series (Sajad M3)', async () => {
      const s = seller();
      const inner = new PrismaPriceSeriesRepository(persistence.service);
      const creatorWrote = openable();
      const handlerDone = openable();
      let adds = 0;
      // The real repository; the first creating attempt waits, after its tombstone read and its
      // insert, until the handler's unit has committed (the interleaving of design 5.1).
      const racing: PriceSeriesRepository = {
        findByKey: (m, key) => inner.findByKey(m, key),
        findByOffer: (m, offerId) => inner.findByOffer(m, offerId),
        findByProductVariant: (m, productId, variantId) =>
          inner.findByProductVariant(m, productId, variantId),
        save: (m, series) => inner.save(m, series),
        add: async (m, series) => {
          adds += 1;
          const outcome = await inner.add(m, series);
          if (adds === 1) {
            creatorWrote.open();
            await handlerDone.opened;
          }
          return outcome;
        },
      };
      retries = 0;
      const writing = useCase(audit, racing).execute(s.context, s.input(base, null));
      await creatorWrote.opened;
      // The Variant-removed handler's unit: the (product, Variant) tombstone, then its live series.
      await runSerializable(persistence.unitOfWork, market, async () => {
        await tombstones.recordRetiredVariant(market, {
          productId: s.productId,
          variantId: s.variantId,
          retiredAt: clock.now(),
          causeEventId: ids.next<'Event'>(),
        });
        for (const found of await inner.findByProductVariant(market, s.productId, s.variantId)) {
          found.retire('variant-removed', clock.now());
          await inner.save(market, found);
        }
        return ok(undefined);
      }).finally(() => handlerDone.open());
      const result = await writing;

      expect(result).toEqual({ ok: false, error: { code: 'pricing.offer-not-found' } });
      expect(adds).toBe(2);
      expect(retries).toBeGreaterThanOrEqual(1);
      const { rows } = await sql.query(
        `SELECT 1 FROM pricing.price_series
          WHERE market_id = $1 AND product_id = $2 AND variant_id = $3 AND retired_at IS NULL`,
        [code, s.productId, s.variantId],
      );
      expect(rows).toEqual([]);
      expect(
        (await auditRows(s.correlationId)).map((r) => [r.action, r.target_id, r.after]),
      ).toEqual([
        [
          'pricing.offer-write.refused',
          s.offerId,
          { variantId: s.variantId, cause: 'key-retired' },
        ],
      ]);
    });

    it('takes the actor row before the (actor, Offer) row: a refusal waiting on a held pair row already holds its actor row (Sajad M2)', async () => {
      const s = seller();
      const foreign = ids.next<'Offer'>();
      // A first refusal creates both rows; two minutes later both windows have expired, so the
      // next refusal updates (and locks) each row instead of skipping it.
      await useCase().execute(s.context, { ...s.input(base, null), offerId: foreign });
      clock.set(clock.now().add({ minutes: 2 }));

      const holder = new Client({ connectionString: testDatabaseUrl() });
      const prober = new Client({ connectionString: testDatabaseUrl() });
      await holder.connect();
      await prober.connect();
      try {
        await holder.query('BEGIN');
        const { rows: held } = await holder.query(
          `SELECT 1 FROM pricing.write_refusal_throttles
            WHERE market_id = $1 AND actor_account_id = $2 AND offer_id = $3 FOR UPDATE`,
          [code, s.accountId, foreign],
        );
        expect(held).toHaveLength(1);
        const { rows: xid } = await holder.query<{ xid: string }>(
          'SELECT pg_current_xact_id()::text AS xid',
        );

        const refusing = useCase().execute(s.context, { ...s.input(base, null), offerId: foreign });
        // Wait until the refusal is queued behind the holder's transaction (the pair row).
        let waiting = false;
        for (let i = 0; i < 500 && !waiting; i += 1) {
          const { rows } = await prober.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_locks
              WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = $1`,
            [xid[0]!.xid],
          );
          waiting = rows[0]!.n > 0;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        // The waiting refusal holds the actor row: it was taken first.
        await expect(
          prober.query(
            `SELECT 1 FROM pricing.write_refusal_actor_throttles
              WHERE market_id = $1 AND actor_account_id = $2 FOR UPDATE NOWAIT`,
            [code, s.accountId],
          ),
        ).rejects.toMatchObject({ code: '55P03' });

        await holder.query('COMMIT');
        expect(await refusing).toEqual({ ok: false, error: { code: 'pricing.offer-not-found' } });
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
        await prober.end();
      }
    });
  },
);
