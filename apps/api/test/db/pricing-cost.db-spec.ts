import { randomBytes } from 'node:crypto';
import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { FakeOfferSellUnits } from '../support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  SetOfferCost,
  type SetOfferCostInput,
} from '../../src/modules/pricing/application/use-cases/set-offer-cost.use-case';
import { ViewOfferCosts } from '../../src/modules/pricing/application/use-cases/view-offer-costs.use-case';
import { PRICING_AUDIT_ACTIONS } from '../../src/modules/pricing/domain/audit';
import { revealCostMinor } from '../../src/modules/pricing/domain/cost/cost-amount';
import { CostSeries } from '../../src/modules/pricing/domain/cost/cost-series';
import { ConfigPricingPolicyProvider } from '../../src/modules/pricing/infrastructure/config-pricing-policy-provider';
import { PrismaCostSeriesRepository } from '../../src/modules/pricing/infrastructure/cost/prisma-cost-series.repository';
import { PrismaRetirementTombstoneRepository } from '../../src/modules/pricing/infrastructure/prisma-retirement-tombstone.repository';
import { PrismaWriteRateCounterRepository } from '../../src/modules/pricing/infrastructure/prisma-write-rate-counter.repository';
import { PrismaWriteRefusalThrottleRepository } from '../../src/modules/pricing/infrastructure/prisma-write-refusal-throttle.repository';
import { AuditActionCatalogue } from '../../src/platform/audit/audit-action-catalogue';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PersistenceModule } from '../../src/platform/persistence/persistence.module';
import { SerializableUnitRequiredError } from '../../src/modules/pricing/application/serializable-unit';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The Cost stream on PostgreSQL (pricing slice 3; pricing-data 3.7, 5.1, 7; design 6.5, 8), for
// both Market fixtures: the CHECKs, the currency foreign key and the append-only triggers of
// migration pricing_cost, as the application and as the owner; then `pricing.set-cost` and
// `pricing.view-cost` with the real Cost repository, audit writer and tombstones.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const policies = new ConfigPricingPolicyProvider(markets);
const CURRENCY: Readonly<Record<string, string>> = { AU: 'AUD', ZZ: 'JPY' };
const T0 = Temporal.Instant.from('2026-11-25T08:00:00Z');
const MAX_SAFE = '9007199254740991';

describe.each(TEST_MARKETS)('pricing Cost in market %s (database integration)', (code) => {
  const market: MarketContext = marketOf(code);
  const currency = CURRENCY[code]!;
  const otherCurrency = CURRENCY[otherMarketOf(code)]!;
  const clock = new FixedClock(T0);
  const ids = new UuidV7IdGenerator(clock);
  let persistence: Persistence;
  let app: Client;
  let owner: Client;
  let audit: AuditWriter;
  let offers: FakeOfferSellUnits;

  beforeAll(async () => {
    persistence = createPersistence();
    app = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await app.connect();
    await owner.connect();
    const catalogue = new AuditActionCatalogue();
    catalogue.register('pricing', PRICING_AUDIT_ACTIONS);
    catalogue.seal();
    audit = PersistenceModule.auditWriterFor('pricing').useFactory(
      catalogue,
      ids,
      clock,
      NO_PERMISSION_KEYS,
    ) as AuditWriter;
  });
  afterAll(async () => {
    await app.end();
    await owner.end();
    await persistence.close();
  });
  beforeEach(() => {
    offers = new FakeOfferSellUnits();
  });

  async function sqlState(client: Client, text: string, values: unknown[] = []) {
    try {
      await client.query(text, values);
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    }
  }

  async function insert(client: Client, table: string, row: Record<string, unknown>) {
    const columns = Object.keys(row);
    return sqlState(
      client,
      `INSERT INTO pricing.${table} (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  }

  async function newSeries(): Promise<string> {
    const id = ids.next();
    expect(
      await insert(app, 'cost_series', {
        id,
        market_id: code,
        tenant_id: 'default',
        offer_id: ids.next(),
        variant_id: ids.next(),
        product_id: ids.next(),
        seller_id: ids.next(),
        currency,
        version: 1,
        created_at: T0.toString(),
      }),
    ).toBeNull();
    return id;
  }

  let version = 0;
  const recordRow = (seriesId: string, overrides: Record<string, unknown> = {}) => ({
    id: ids.next(),
    market_id: code,
    tenant_id: 'default',
    cost_series_id: seriesId,
    series_version: (version += 1),
    kind: 'amount',
    amount_minor: '1250',
    currency,
    submitted_at: T0.toString(),
    submitted_by_account_id: ids.next(),
    ...overrides,
  });

  describe('constraints, grants and triggers (pricing-data 3.7, 7)', () => {
    it('accepts an amount and a cleared record; refuses a mismatched kind, a range breach and another currency', async () => {
      const series = await newSeries();
      expect(await insert(app, 'cost_records', recordRow(series))).toBeNull();
      expect(
        await insert(
          app,
          'cost_records',
          recordRow(series, { kind: 'cleared', amount_minor: null }),
        ),
      ).toBeNull();
      expect(
        await insert(app, 'cost_records', recordRow(series, { amount_minor: MAX_SAFE })),
      ).toBeNull();
      for (const bad of [
        { kind: 'cleared' },
        { amount_minor: null },
        { amount_minor: '0' },
        { amount_minor: '9007199254740992' },
        { kind: 'margin' },
      ]) {
        expect(await insert(app, 'cost_records', recordRow(series, bad))).toBe('23514');
      }
      // One record per series version (the order of the stream, never the instant).
      expect(await insert(app, 'cost_records', recordRow(series, { series_version: 1 }))).toBe(
        '23505',
      );
      expect(await insert(app, 'cost_records', recordRow(series, { series_version: 0 }))).toBe(
        '23514',
      );
      // P2: a record in another currency than its series breaks the composite foreign key.
      expect(
        await insert(app, 'cost_records', recordRow(series, { currency: otherCurrency })),
      ).toBe('23503');
    });

    it('lets the application change only version and retirement of a series (42501 otherwise, no DELETE)', async () => {
      const series = await newSeries();
      const where = `WHERE market_id = '${code}' AND id = $1`;
      expect(
        await sqlState(app, `UPDATE pricing.cost_series SET version = 2 ${where}`, [series]),
      ).toBeNull();
      for (const column of ['seller_id', 'offer_id', 'variant_id', 'product_id']) {
        expect(
          await sqlState(app, `UPDATE pricing.cost_series SET ${column} = $2 ${where}`, [
            series,
            ids.next(),
          ]),
        ).toBe('42501');
      }
      expect(await sqlState(app, `DELETE FROM pricing.cost_series ${where}`, [series])).toBe(
        '42501',
      );
    });

    it('keeps records append-only: 42501 for the application, 23001 for the owner', async () => {
      const series = await newSeries();
      const row = recordRow(series);
      expect(await insert(app, 'cost_records', row)).toBeNull();
      const where = `WHERE market_id = '${code}' AND id = $1`;
      expect(
        await sqlState(app, `UPDATE pricing.cost_records SET amount_minor = 1 ${where}`, [row.id]),
      ).toBe('42501');
      expect(
        await sqlState(owner, `UPDATE pricing.cost_records SET amount_minor = 1 ${where}`, [
          row.id,
        ]),
      ).toBe('23001');
      expect(await sqlState(app, `DELETE FROM pricing.cost_records ${where}`, [row.id])).toBe(
        '42501',
      );
      expect(await sqlState(owner, `DELETE FROM pricing.cost_records ${where}`, [row.id])).toBe(
        '23001',
      );
      expect(await sqlState(app, 'TRUNCATE pricing.cost_records')).toBe('42501');
      expect(await sqlState(owner, 'TRUNCATE pricing.cost_records')).toBe('23001');
    });
  });

  describe('pricing.set-cost and pricing.view-cost', () => {
    const repository = () => new PrismaCostSeriesRepository(persistence.service);

    function useCases() {
      const deps = {
        unitOfWork: persistence.unitOfWork,
        costs: repository(),
        throttles: new PrismaWriteRefusalThrottleRepository(persistence.service),
        counters: new PrismaWriteRateCounterRepository(persistence.service),
        offers,
        policies,
        audit,
        clock,
        ids,
      };
      return {
        set: new SetOfferCost(gate, deps),
        view: new ViewOfferCosts(gate, deps),
      };
    }

    function seller() {
      const sellerId = ids.next<'Seller'>();
      const offerId = ids.next<'Offer'>();
      const variantId = ids.next<'Variant'>();
      const productId = ids.next<'Product'>();
      const correlationId = `pricing-cost-${randomBytes(6).toString('hex')}`;
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
        productId,
        deleted: false,
        priceableVariantIds: [variantId],
      });
      const input = (amount: bigint | null, expectedVersion: number | null): SetOfferCostInput => ({
        offerId,
        variantId,
        cost: amount === null ? null : { amount: amount.toString(), currency },
        expectedVersion,
      });
      return { sellerId, offerId, variantId, productId, correlationId, context, input };
    }

    it('records, re-records and clears; the rows are append-only; the audit rows carry no amount', async () => {
      const s = seller();
      const { set, view } = useCases();
      expect(await set.execute(s.context, s.input(4_321n, null))).toEqual({
        ok: true,
        value: { status: 'recorded', seriesVersion: 1 },
      });
      expect(await set.execute(s.context, s.input(4_322n, 1))).toEqual({
        ok: true,
        value: { status: 'recorded', seriesVersion: 2 },
      });
      expect(await set.execute(s.context, s.input(4_322n, 2))).toEqual({
        ok: true,
        value: { status: 'unchanged', seriesVersion: 2 },
      });

      const read = await view.execute(s.context, { offerId: s.offerId });
      if (!read.ok) throw new Error(read.error.code);
      expect(read.value.variants).toHaveLength(1);
      expect(read.value.variants[0]!.seriesVersion).toBe(2);
      expect(revealCostMinor(read.value.variants[0]!.cost!)).toEqual({ amount: 4_322n, currency });

      expect(await set.execute(s.context, s.input(null, 2))).toEqual({
        ok: true,
        value: { status: 'cleared', seriesVersion: 3 },
      });
      const cleared = await view.execute(s.context, { offerId: s.offerId });
      expect(cleared.ok && cleared.value.variants[0]!.cost).toBeNull();

      const { rows } = await app.query<{ kind: string; amount_minor: string | null }>(
        `SELECT r.kind, r.amount_minor FROM pricing.cost_records r
         JOIN pricing.cost_series s ON s.market_id = r.market_id AND s.id = r.cost_series_id
         WHERE s.market_id = $1 AND s.offer_id = $2 ORDER BY r.series_version`,
        [code, s.offerId],
      );
      expect(rows).toEqual([
        { kind: 'amount', amount_minor: '4321' },
        { kind: 'amount', amount_minor: '4322' },
        { kind: 'cleared', amount_minor: null },
      ]);
      const { rows: auditRows } = await app.query<{ action: string; after: unknown }>(
        `SELECT action, after FROM platform.audit_log
         WHERE market_id = $1 AND correlation_id = $2 ORDER BY occurred_at, id`,
        [code, s.correlationId],
      );
      // The clock is fixed, so the three rows share an instant: compared as a set.
      expect(auditRows.map((row) => row.action).sort()).toEqual([
        'pricing.cost.cleared',
        'pricing.cost.set',
        'pricing.cost.set',
      ]);
      expect(JSON.stringify(auditRows)).not.toMatch(/4321|4322/);
      const { rows: outbox } = await app.query(
        `SELECT 1 FROM pricing.outbox WHERE market_id = $1 AND correlation_id = $2`,
        [code, s.correlationId],
      );
      expect(outbox).toEqual([]);
    });

    it('answers a stale version with conflict.stale and writes nothing', async () => {
      const s = seller();
      const { set } = useCases();
      await set.execute(s.context, s.input(1_000n, null));
      expect(await set.execute(s.context, s.input(2_000n, null))).toEqual({
        ok: false,
        error: { code: 'conflict.stale' },
      });
    });

    it('refuses to create a series behind a tombstone: pricing.offer-not-found, no row', async () => {
      const s = seller();
      const tombstones = new PrismaRetirementTombstoneRepository(persistence.service);
      await persistence.unitOfWork.run(market, async () => ({
        ok: true as const,
        value: await tombstones.recordRetiredOffer(market, {
          offerId: s.offerId,
          retiredAt: T0,
          causeEventId: ids.next<'Event'>(),
        }),
      }));
      expect(await useCases().set.execute(s.context, s.input(1_000n, null))).toEqual({
        ok: false,
        error: { code: 'pricing.offer-not-found' },
      });
      const { rows } = await app.query(
        `SELECT 1 FROM pricing.cost_series WHERE market_id = $1 AND offer_id = $2`,
        [code, s.offerId],
      );
      expect(rows).toEqual([]);
    });

    it('refuses add outside a serializable unit (Hassan M1), before any read', async () => {
      const s = seller();
      const series = CostSeries.create({
        id: ids.next<'CostSeries'>(),
        marketId: market.marketId,
        offerId: s.offerId,
        variantId: s.variantId,
        productId: s.productId,
        sellerId: s.sellerId,
        currency,
        now: T0,
      });
      series.setCost({
        recordId: ids.next<'CostRecord'>(),
        amount: null,
        submittedBy: ids.next<'Account'>(),
        now: T0,
      });
      await expect(
        persistence.unitOfWork.run(market, async () => ({
          ok: true as const,
          value: await repository().add(market, series),
        })),
      ).rejects.toThrow(SerializableUnitRequiredError);
    });

    it('does not find another Market’s series', async () => {
      const s = seller();
      await useCases().set.execute(s.context, s.input(1_000n, null));
      const other = marketOf(otherMarketOf(code));
      const found = await persistence.unitOfWork.run(
        other,
        async () => ({
          ok: true as const,
          value: await repository().findByKey(other, {
            offerId: s.offerId,
            variantId: s.variantId,
          }),
        }),
        { readOnly: true },
      );
      expect(found).toEqual({ ok: true, value: null });
    });
  });
});
