import { randomBytes } from 'node:crypto';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { FakeOfferSellUnits } from '../support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { PublishSpecialPriceBoundaries } from '../../src/modules/pricing/application/use-cases/publish-special-price-boundaries.use-case';
import { PRICE_WRITE_LIMITS } from '../../src/modules/pricing/domain/write-rate-limits';
import { SetRegularPrice } from '../../src/modules/pricing/application/use-cases/set-regular-price.use-case';
import { SetSpecialPrice } from '../../src/modules/pricing/application/use-cases/set-special-price.use-case';
import { WithdrawSpecialPrice } from '../../src/modules/pricing/application/use-cases/withdraw-special-price.use-case';
import { PRICING_AUDIT_ACTIONS } from '../../src/modules/pricing/domain/audit';
import { PRICING_EVENTS } from '../../src/modules/pricing/domain/events';
import { ConfigPricingPolicyProvider } from '../../src/modules/pricing/infrastructure/config-pricing-policy-provider';
import { PrismaPriceSeriesRepository } from '../../src/modules/pricing/infrastructure/prisma-price-series.repository';
import { PrismaWriteRateCounterRepository } from '../../src/modules/pricing/infrastructure/prisma-write-rate-counter.repository';
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
import { createPersistence, marketOf, modelMap, type Persistence } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Special prices on PostgreSQL (pricing slice 5), for both Market fixtures, with the real
// repository, outbox writer and audit writer: the write order of a replacement, the EXCLUDE
// constraint on effective periods, the write-once trigger, and the queue read.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const policies = new ConfigPricingPolicyProvider(markets);

const BASE = { AU: { currency: 'AUD', base: 10_000n }, ZZ: { currency: 'JPY', base: 1_000n } };

describe.each(TEST_MARKETS)('special prices in market %s (database integration)', (code) => {
  const market: MarketContext = marketOf(code);
  const { currency, base } = BASE[code];
  const clock = new FixedClock(Temporal.Instant.from('2026-10-08T10:00:00Z'));
  const ids = new UuidV7IdGenerator(clock);
  let persistence: Persistence;
  let sql: Client;
  let audit: AuditWriter;
  let offers: FakeOfferSellUnits;
  let throttles: PrismaWriteRefusalThrottleRepository;
  let repository: PrismaPriceSeriesRepository;

  beforeAll(async () => {
    persistence = createPersistence({ pause: () => Promise.resolve() });
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
    repository = new PrismaPriceSeriesRepository(persistence.service);
  });
  afterAll(async () => {
    await sql.end();
    await persistence.close();
  });
  beforeEach(() => {
    offers = new FakeOfferSellUnits();
    clock.set(Temporal.Instant.from('2026-10-08T10:00:00Z'));
  });

  function dependencies() {
    const events = new EventCatalogue();
    events.register('pricing', PRICING_EVENTS);
    events.seal();
    return {
      unitOfWork: persistence.unitOfWork,
      series: repository,
      throttles,
      counters: new PrismaWriteRateCounterRepository(persistence.service),
      offers,
      policies,
      audit,
      outbox: new PrismaOutboxWriterFactory(
        modelMap,
        persistence.service,
        events,
        ids,
        NO_PERMISSION_KEYS,
      ).forModule('pricing'),
      clock,
      ids,
    };
  }

  function seller() {
    const sellerId = ids.next<'Seller'>();
    const offerId = ids.next<'Offer'>();
    const variantId = ids.next<'Variant'>();
    const correlationId = `pricing-db-${randomBytes(6).toString('hex')}`;
    const context: CallContext = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId,
      }),
      correlationId,
    );
    offers.put(market, offerId, {
      sellerId,
      productId: ids.next<'Product'>(),
      deleted: false,
      priceableVariantIds: [variantId],
    });
    const regular = (amount: bigint, expectedVersion: number | null) => ({
      offerId,
      variantId,
      price: { amount: amount.toString(), currency },
      expectedVersion,
    });
    const special = (amount: bigint, endsAt: string, expectedVersion: number) => ({
      offerId,
      variantId,
      price: { amount: amount.toString(), currency },
      startsAt: null,
      endsAt,
      expectedVersion,
    });
    return { offerId, variantId, correlationId, context, regular, special };
  }

  const specialRows = async (offerId: string) =>
    (
      await sql.query<{
        id: string;
        status: string;
        withdrawn_at: Date | null;
        effective_from: Date | null;
      }>(
        `SELECT r.id, r.status, r.withdrawn_at, r.effective_from FROM pricing.special_price_records r
        JOIN pricing.price_series s ON s.market_id = r.market_id AND s.id = r.series_id
        WHERE s.market_id = $1 AND s.offer_id = $2 ORDER BY r.submitted_at, r.id`,
        [code, offerId],
      )
    ).rows;

  it('sets a special, replaces it in order, withdraws it, and audits each step', async () => {
    const s = seller();
    const deps = dependencies();
    const setRegular = new SetRegularPrice(gate, deps);
    const setSpecial = new SetSpecialPrice(gate, deps);
    const withdraw = new WithdrawSpecialPrice(gate, deps);
    await setRegular.execute(s.context, s.regular(base, null));
    const end = '2026-10-12T10:00:00Z';

    clock.set(clock.now().add({ seconds: 5 }));
    const first = await setSpecial.execute(s.context, s.special((base * 9n) / 10n, end, 2));
    expect(first).toMatchObject({ ok: true, value: { status: 'accepted', seriesVersion: 3 } });
    clock.set(clock.now().add({ seconds: 5 }));
    const second = await setSpecial.execute(s.context, s.special((base * 8n) / 10n, end, 3));
    expect(second).toMatchObject({ ok: true, value: { status: 'accepted', seriesVersion: 4 } });

    const replaced = await specialRows(s.offerId);
    expect(replaced.map((r) => r.status)).toEqual(['withdrawn', 'accepted']);
    expect(replaced[0]!.withdrawn_at).not.toBeNull();

    clock.set(clock.now().add({ seconds: 5 }));
    const ended = await withdraw.execute(s.context, {
      offerId: s.offerId,
      variantId: s.variantId,
      expectedVersion: 4,
    });
    expect(ended).toMatchObject({ ok: true, value: { seriesVersion: 5 } });
    expect((await specialRows(s.offerId)).map((r) => r.status)).toEqual(['withdrawn', 'withdrawn']);

    const { rows } = await sql.query<{ action: string }>(
      `SELECT action FROM platform.audit_log WHERE market_id = $1 AND correlation_id = $2
      ORDER BY occurred_at, id`,
      [code, s.correlationId],
    );
    const actions = rows.map((r) => r.action).filter((a) => a.startsWith('pricing.special-price.'));
    expect([...actions].sort()).toEqual([
      'pricing.special-price.accepted',
      'pricing.special-price.accepted',
      'pricing.special-price.withdrawn',
      'pricing.special-price.withdrawn',
    ]);
  });

  it('refuses two specials with overlapping effective periods and a rewrite of content', async () => {
    const s = seller();
    const deps = dependencies();
    await new SetRegularPrice(gate, deps).execute(s.context, s.regular(base, null));
    clock.set(clock.now().add({ seconds: 5 }));
    await new SetSpecialPrice(gate, deps).execute(
      s.context,
      s.special((base * 9n) / 10n, '2026-10-12T10:00:00Z', 2),
    );
    const [row] = await specialRows(s.offerId);

    await expect(
      sql.query(
        `UPDATE pricing.special_price_records SET amount_minor = amount_minor + 1 WHERE id = $1`,
        [row!.id],
      ),
    ).rejects.toThrow();
    await expect(
      sql.query(
        `INSERT INTO pricing.special_price_records
        (id, market_id, tenant_id, series_id, currency, amount_minor, tax_inclusive, status,
         starts_at, ends_at, submitted_at, submitted_by, regular_record_id, regular_amount_minor,
         anchor_record_id, anchor_amount_minor, effective_from)
        SELECT $1, market_id, tenant_id, series_id, currency, amount_minor, tax_inclusive, 'ACCEPTED',
         starts_at, ends_at, submitted_at, submitted_by, regular_record_id, regular_amount_minor,
         anchor_record_id, anchor_amount_minor, effective_from
        FROM pricing.special_price_records WHERE id = $2`,
        [ids.next<'SpecialPriceRecord'>(), row!.id],
      ),
    ).rejects.toThrow();
  });

  it('finds a record by id and lists a held special in the queue (AU only; ZZ holds only rises)', async () => {
    const s = seller();
    const deps = dependencies();
    await new SetRegularPrice(gate, deps).execute(s.context, s.regular(base, null));
    clock.set(clock.now().add({ seconds: 5 }));
    const result = await new SetSpecialPrice(gate, deps).execute(
      s.context,
      s.special(code === 'AU' ? base / 5n : (base * 9n) / 10n, '2026-10-12T10:00:00Z', 2),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));

    const recordId = result.value.recordId;
    const read = await persistence.unitOfWork.run(
      market,
      async () =>
        ok({
          found: await repository.findByRecordId(market, recordId),
          queued: await repository.findPendingHold(market, recordId),
        }),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('read failed');
    expect(read.value.found?.hasSpecial(recordId)).toBe(true);
    expect(read.value.queued === null).toBe(code !== 'AU');
    expect(result.value.status).toBe(code === 'AU' ? 'pending-review' : 'accepted');
  });
  describe('the boundary job', () => {
    const publisher = () => {
      const deps = dependencies();
      return new PublishSpecialPriceBoundaries(gate, {
        unitOfWork: persistence.unitOfWork,
        series: repository,
        outbox: deps.outbox,
        clock,
      });
    };
    const causesOf = async (offerId: string) =>
      (
        await sql.query<{ cause: string }>(
          `SELECT o.payload->>'cause' AS cause FROM pricing.outbox o
          JOIN pricing.price_series s ON s.market_id = o.market_id AND s.id = o.aggregate_id
          WHERE s.market_id = $1 AND s.offer_id = $2 ORDER BY o.aggregate_version`,
          [code, offerId],
        )
      ).rows.map((r) => r.cause);
    const markersOf = async (offerId: string) =>
      (
        await sql.query<{ boundary: string }>(
          `SELECT b.boundary FROM pricing.special_price_boundaries b
          JOIN pricing.special_price_records r ON r.market_id = b.market_id AND r.id = b.special_record_id
          JOIN pricing.price_series s ON s.market_id = r.market_id AND s.id = r.series_id
          WHERE s.market_id = $1 AND s.offer_id = $2 ORDER BY b.boundary`,
          [code, offerId],
        )
      ).rows.map((r) => r.boundary);

    it('announces the start and the end of a special once each, writing the marker first', async () => {
      const s = seller();
      const deps = dependencies();
      await new SetRegularPrice(gate, deps).execute(s.context, s.regular(base, null));
      clock.set(clock.now().add({ seconds: 5 }));
      const endsAt = clock.now().add({ hours: 3 });
      const set = await new SetSpecialPrice(gate, deps).execute(
        s.context,
        s.special((base * 9n) / 10n, endsAt.toString(), 2),
      );
      expect(set.ok).toBe(true);
      const system = testCallContext(market, 'system');

      clock.set(clock.now().add({ minutes: 1 }));
      const first = await publisher().execute(system, {});
      // Other specials of the file may be due too: this offer's marker is what is asserted.
      expect(first).toMatchObject({ ok: true, value: { failed: 0 } });
      expect(first.ok && first.value.announced).toBeGreaterThanOrEqual(1);
      expect(await markersOf(s.offerId)).toEqual(['start']);
      // A repeated run finds the marker: no second event.
      const again = await publisher().execute(system, {});
      expect(again).toMatchObject({ ok: true, value: { announced: 0, failed: 0 } });

      clock.set(endsAt.add({ minutes: 1 }));
      const last = await publisher().execute(system, {});
      expect(last).toMatchObject({ ok: true, value: { failed: 0 } });
      expect(last.ok && last.value.announced).toBeGreaterThanOrEqual(1);
      expect(await markersOf(s.offerId)).toEqual(['end', 'start']);
      expect(await causesOf(s.offerId)).toEqual([
        'regular-accepted',
        'special-started',
        'special-started',
        'special-ended',
      ]);
    });

    it('refuses to change or remove a marker, and to mark a record of another Market', async () => {
      const s = seller();
      const deps = dependencies();
      await new SetRegularPrice(gate, deps).execute(s.context, s.regular(base, null));
      clock.set(clock.now().add({ seconds: 5 }));
      await new SetSpecialPrice(gate, deps).execute(
        s.context,
        s.special((base * 9n) / 10n, clock.now().add({ hours: 3 }).toString(), 2),
      );
      clock.set(clock.now().add({ minutes: 1 }));
      await publisher().execute(testCallContext(market, 'system'), {});

      await expect(
        sql.query(
          `UPDATE pricing.special_price_boundaries SET marked_at = now() WHERE market_id = $1`,
          [code],
        ),
      ).rejects.toThrow();
      await expect(
        sql.query(`DELETE FROM pricing.special_price_boundaries WHERE market_id = $1`, [code]),
      ).rejects.toThrow();
    });
  });

  describe('the per-account write counters', () => {
    const counters = () => new PrismaWriteRateCounterRepository(persistence.service);
    const reserve = async (
      account: ReturnType<typeof ids.next<'Account'>>,
      at: Temporal.Instant,
    ) => {
      const done = await persistence.unitOfWork.run(market, async () =>
        ok(await counters().reserve(market, account, PRICE_WRITE_LIMITS, at)),
      );
      if (!done.ok) throw new Error('reserve failed');
      return done.value;
    };

    it('counts every attempt once, restarts an ended window and purges old windows', async () => {
      const account = ids.next<'Account'>();
      const t0 = clock.now();
      const counts = async (at: Temporal.Instant) =>
        (await reserve(account, at)).map((r) => [r.kind, r.count]);
      expect(await counts(t0)).toEqual([
        ['write.account.day', 1],
        ['write.account.minute', 1],
      ]);
      expect(await counts(t0.add({ seconds: 10 }))).toEqual([
        ['write.account.day', 2],
        ['write.account.minute', 2],
      ]);
      // The minute window ended; the day window did not.
      expect(await counts(t0.add({ seconds: 61 }))).toEqual([
        ['write.account.day', 3],
        ['write.account.minute', 1],
      ]);
      const other = await reserve(ids.next<'Account'>(), t0);
      expect(other.map((r) => r.count)).toEqual([1, 1]);

      const purged = await persistence.unitOfWork.run(market, async () =>
        ok(await counters().purgeStartedBefore(market, t0.add({ hours: 72 }))),
      );
      expect(purged.ok).toBe(true);
      const left = await sql.query(
        `SELECT 1 FROM pricing.write_rate_counters WHERE market_id = $1 AND actor_account_id = $2`,
        [code, account],
      );
      expect(left.rowCount).toBe(0);
    });

    it('counts parallel first attempts of one account exactly once each, without deadlock', async () => {
      const account = ids.next<'Account'>();
      const at = clock.now();
      const parallel = 12;
      await Promise.all(Array.from({ length: parallel }, () => reserve(account, at)));
      const rows = await sql.query<{ kind: string; count: number }>(
        `SELECT kind, count FROM pricing.write_rate_counters
        WHERE market_id = $1 AND actor_account_id = $2 ORDER BY kind`,
        [code, account],
      );
      expect(rows.rows).toEqual([
        { kind: 'write.account.day', count: parallel },
        { kind: 'write.account.minute', count: parallel },
      ]);
    });
  });
});
