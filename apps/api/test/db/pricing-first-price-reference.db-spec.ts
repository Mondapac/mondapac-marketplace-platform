import { randomBytes } from 'node:crypto';
import { money, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { FakeOfferSellUnits } from '../support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import type {
  ReferenceBusinesses,
  ReferenceSettingsSource,
} from '../../src/modules/pricing/application/ports/first-price-reference';
import { SetRegularPrice } from '../../src/modules/pricing/application/use-cases/set-regular-price.use-case';
import { PRICING_AUDIT_ACTIONS } from '../../src/modules/pricing/domain/audit';
import { PRICING_EVENTS } from '../../src/modules/pricing/domain/events';
import { priceAmount } from '../../src/modules/pricing/domain/price-amount';
import { PriceSeries } from '../../src/modules/pricing/domain/price-series';
import { ConfigPricingPolicyProvider } from '../../src/modules/pricing/infrastructure/config-pricing-policy-provider';
import { PrismaFirstPriceChecks } from '../../src/modules/pricing/infrastructure/prisma-first-price-checks';
import { PrismaPriceSeriesRepository } from '../../src/modules/pricing/infrastructure/prisma-price-series.repository';
import { PrismaWriteRateCounterRepository } from '../../src/modules/pricing/infrastructure/prisma-write-rate-counter.repository';
import { PrismaWriteRefusalThrottleRepository } from '../../src/modules/pricing/infrastructure/prisma-write-refusal-throttle.repository';
import { runSerializable } from '../../src/modules/pricing/application/serializable-unit';
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
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// R4 of the risk-based Offer approval on PostgreSQL (ADR-0051; migration
// pricing_first_price_reference), for both Market fixtures: a first price held against the
// Variant's median is stored with its reference and no anchor, and is listed in the price queue;
// the check rows, the re-check (once), the CHECKs, the write-once triggers and the grants. The
// facades (catalog, sellers, settings) are fakes.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const policies = new ConfigPricingPolicyProvider(markets);
const CURRENCY = { AU: 'AUD', ZZ: 'JPY' } as const;

describe.each(TEST_MARKETS)(
  'R4 first-price reference in market %s (database integration)',
  (code) => {
    const market: MarketContext = marketOf(code);
    const currency = CURRENCY[code];
    const T0 = Temporal.Instant.from('2026-11-25T10:00:00Z');
    const clock = new FixedClock(T0);
    const ids = new UuidV7IdGenerator(clock);
    let persistence: Persistence;
    let sql: Client;
    let audit: AuditWriter;
    let offers: FakeOfferSellUnits;
    let series: PrismaPriceSeriesRepository;
    let checks: PrismaFirstPriceChecks;
    const eligible = new Set<string>();
    const businesses: ReferenceBusinesses = {
      eligibleSellers: (_context, sellerIds) =>
        Promise.resolve(new Set(sellerIds.filter((id) => eligible.has(id)))),
    };
    let referenceSellers = 3;
    const settings: ReferenceSettingsSource = {
      settings: () => Promise.resolve({ referenceSellers, priceBandPercent: 50 }),
    };

    beforeAll(async () => {
      persistence = createPersistence();
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
      series = new PrismaPriceSeriesRepository(persistence.service);
      checks = new PrismaFirstPriceChecks(persistence.service);
    });
    afterAll(async () => {
      await sql.end();
      await persistence.close();
    });
    beforeEach(() => {
      offers = new FakeOfferSellUnits();
      clock.set(T0);
      referenceSellers = 3;
    });

    function useCase(): SetRegularPrice {
      const events = new EventCatalogue();
      events.register('pricing', PRICING_EVENTS);
      events.seal();
      return new SetRegularPrice(gate, {
        unitOfWork: persistence.unitOfWork,
        series,
        throttles: new PrismaWriteRefusalThrottleRepository(persistence.service),
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
        reference: { prices: checks, checks, businesses, settings },
      });
    }

    /** A product with one Variant; `seller` adds a seller's Offer on it, priced or not. */
    function variant() {
      const productId = ids.next<'Product'>();
      const variantId = ids.next<'Variant'>();
      const seller = async (price?: bigint, special?: bigint) => {
        const sellerId = ids.next<'Seller'>();
        const accountId = ids.next<'Account'>();
        const offerId = ids.next<'Offer'>();
        eligible.add(sellerId);
        offers.put(market, offerId, {
          sellerId,
          productId,
          deleted: false,
          priceableVariantIds: [variantId],
          liveVariantIds: [variantId],
        });
        if (price !== undefined) {
          const policy = policies.forMarket(market);
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
          const amount = priceAmount(money(price, currency), policy);
          if (!amount.ok) throw new Error('fixture amount');
          s.setRegularPrice({
            recordId: ids.next<'RegularPriceRecord'>(),
            amount: amount.value,
            submittedBy: accountId,
            taxInclusive: true,
            now: T0.subtract({ hours: 1 }),
            policy,
          });
          if (special !== undefined) {
            const off = priceAmount(money(special, currency), policy);
            if (!off.ok) throw new Error('fixture special');
            const sale = s.setSpecialPrice({
              recordId: ids.next<'SpecialPriceRecord'>(),
              amount: off.value,
              submittedBy: accountId,
              taxInclusive: true,
              startsAt: null,
              endsAt: T0.add({ hours: 24 }),
              now: T0.subtract({ minutes: 30 }),
              policy,
            });
            if (!sale.ok || sale.value.kind !== 'accepted') {
              throw new Error('fixture special not accepted');
            }
          }
          const added = await runSerializable(persistence.unitOfWork, market, async () => ({
            ok: true as const,
            value: await series.add(market, s),
          }));
          expect(added).toEqual({ ok: true, value: 'added' });
        }
        const context: CallContext = testCallContext(
          market,
          testAuthenticatedActor(market, {
            population: 'seller',
            accountId,
            sessionId: ids.next<'Session'>(),
            sellerId,
          }),
          `pricing-r4-${randomBytes(6).toString('hex')}`,
        );
        const write = (amount: bigint) =>
          useCase().execute(context, {
            offerId,
            variantId,
            price: { amount: amount.toString(), currency },
            expectedVersion: null,
          });
        return { sellerId, offerId, write };
      };
      return { productId, variantId, seller };
    }

    async function sqlState(text: string, values: unknown[] = []): Promise<string | null> {
      try {
        await sql.query(text, values);
        return null;
      } catch (error) {
        return (error as { code?: string }).code ?? 'unknown';
      }
    }

    it('stores a first price held against the median with its reference and no anchor, and queues it', async () => {
      const v = variant();
      for (const price of [900n, 1_000n, 1_200n]) await v.seller(price);
      const newcomer = await v.seller();

      const written = await newcomer.write(1_501n);
      expect(written).toMatchObject({ ok: true, value: { status: 'pending-review' } });
      const recordId = written.ok ? written.value.recordId : null;

      const { rows } = await sql.query(
        `SELECT status, anchor_record_id, reference_amount_minor::text, reference_businesses,
              reference_band_percent, hold_direction
       FROM pricing.regular_price_records WHERE market_id = $1 AND id = $2`,
        [code, recordId],
      );
      expect(rows).toEqual([
        {
          status: 'pending-review',
          anchor_record_id: null,
          reference_amount_minor: '1000',
          reference_businesses: 3,
          reference_band_percent: 50,
          hold_direction: 'up',
        },
      ]);
      const { rows: stored } = await sql.query(
        `SELECT outcome, reference_amount_minor::text, post_review_reason
       FROM pricing.first_price_checks WHERE market_id = $1 AND record_id = $2`,
        [code, recordId],
      );
      expect(stored).toEqual([
        { outcome: 'outside', reference_amount_minor: '1000', post_review_reason: null },
      ]);

      // The repository reads it back (the domain's stored-state checks pass) and the queue lists it.
      const restored = await persistence.unitOfWork.run(
        market,
        async () => ({
          ok: true as const,
          value: await series.findByKey(market, {
            offerId: newcomer.offerId,
            variantId: v.variantId,
          }),
        }),
        { readOnly: true },
      );
      expect(restored.ok && restored.value?.state.regular[0]?.reference?.businesses).toBe(3);
      const hold = await persistence.unitOfWork.run(
        market,
        async () => ({
          ok: true as const,
          value: await series.findPendingHold(market, recordId as Id<'RegularPriceRecord'>),
        }),
        { readOnly: true },
      );
      expect(hold.ok && hold.value).toMatchObject({ basis: 'reference', anchorRecordId: null });
    });

    it('measures against regular prices only: a special price in force is not a reference', async () => {
      const v = variant();
      // Regular 1000 each, on sale at 900: with the specials the band would end at 1350.
      for (let i = 0; i < 3; i += 1) await v.seller(1_000n, 900n);
      const { rows: sales } = await sql.query(
        `SELECT count(*)::int AS n FROM pricing.special_price_records r
         JOIN pricing.price_series s ON s.market_id = r.market_id AND s.id = r.series_id
       WHERE r.market_id = $1 AND s.variant_id = $2 AND r.status = 'accepted'`,
        [code, v.variantId],
      );
      expect(sales).toEqual([{ n: 3 }]);
      const written = await (await v.seller()).write(1_400n);
      expect(written).toMatchObject({ ok: true, value: { status: 'accepted' } });
      const recordId = written.ok ? written.value.recordId : null;
      const { rows } = await sql.query(
        `SELECT outcome, reference_amount_minor::text FROM pricing.first_price_checks
       WHERE market_id = $1 AND record_id = $2`,
        [code, recordId],
      );
      expect(rows).toEqual([{ outcome: 'within', reference_amount_minor: '1000' }]);
    });

    it('stores a no-reference check for post-publication review, then re-checks it once', async () => {
      referenceSellers = 2;
      const v = variant();
      const early = await v.seller();
      expect(await early.write(5_000n)).toMatchObject({ ok: true, value: { status: 'accepted' } });
      for (const price of [1_000n, 1_100n]) await v.seller(price);
      clock.set(T0.add({ minutes: 1 }));

      const later = await v.seller();
      expect(await later.write(1_050n)).toMatchObject({ ok: true, value: { status: 'accepted' } });

      const { rows } = await sql.query(
        `SELECT outcome, post_review_reason, recheck_outcome, recheck_reference_amount_minor::text,
              recheck_amount_minor::text, rechecked_at IS NOT NULL AS rechecked
       FROM pricing.first_price_checks WHERE market_id = $1 AND seller_id = $2`,
        [code, early.sellerId],
      );
      expect(rows).toEqual([
        {
          outcome: 'no-reference',
          post_review_reason: 'recheck-outside',
          recheck_outcome: 'outside',
          recheck_reference_amount_minor: '1050',
          recheck_amount_minor: '5000',
          rechecked: true,
        },
      ]);

      // Catalog's post-publication review list hears of both flags through pricing's outbox, in
      // the units that stored them: version 1 (the first check) and 2 (the re-check) of the record.
      const { rows: flags } = await sql.query(
        `SELECT o.aggregate_version, o.payload->>'reason' AS reason,
                o.payload->>'recordId' = c.record_id::text AS keyed
         FROM pricing.outbox o
         JOIN pricing.first_price_checks c
           ON c.market_id = o.market_id AND c.record_id::text = o.aggregate_id::text
         WHERE o.market_id = $1 AND c.seller_id = $2
           AND o.type = 'pricing.offer-post-review-flagged.v1'
         ORDER BY o.aggregate_version`,
        [code, early.sellerId],
      );
      expect(flags).toEqual([
        { aggregate_version: 1, reason: 'no-reference', keyed: true },
        { aggregate_version: 2, reason: 'recheck-outside', keyed: true },
      ]);

      const { rows: pending } = await sql.query<{ record_id: Id<'RegularPriceRecord'> }>(
        `SELECT record_id FROM pricing.first_price_checks WHERE market_id = $1 AND seller_id = $2`,
        [code, early.sellerId],
      );
      const again = await persistence.unitOfWork.run(market, async () => ({
        ok: true as const,
        value: await checks.markRechecked(market, {
          recordId: pending[0]!.record_id,
          outcome: 'within',
          referenceAmountMinor: 1n,
          amountMinor: 1n,
          at: T0.add({ minutes: 5 }),
        }),
      }));
      expect(again).toEqual({ ok: true, value: false });
    });

    it('refuses what no write could produce: CHECKs, write-once triggers and grants', async () => {
      const v = variant();
      const newcomer = await v.seller();
      const written = await newcomer.write(1_000n);
      const recordId = written.ok ? written.value.recordId : null;

      // The application role cannot change a record's reference, nor a check's content, nor delete.
      expect(
        await sqlState(
          `UPDATE pricing.regular_price_records SET reference_amount_minor = 1
         WHERE market_id = $1 AND id = $2`,
          [code, recordId],
        ),
      ).toBe('42501');
      expect(
        await sqlState(
          `UPDATE pricing.first_price_checks SET outcome = 'within'
         WHERE market_id = $1 AND record_id = $2`,
          [code, recordId],
        ),
      ).toBe('42501');
      expect(
        await sqlState(
          `DELETE FROM pricing.first_price_checks WHERE market_id = $1 AND record_id = $2`,
          [code, recordId],
        ),
      ).toBe('42501');
      // A re-check of a check that had a reference, or a half-written re-check, is refused.
      expect(
        await sqlState(
          `UPDATE pricing.first_price_checks SET rechecked_at = now()
         WHERE market_id = $1 AND record_id = $2`,
          [code, recordId],
        ),
      ).toBe('23514');
    });

    it('refuses, even to the owner, a change of a check, DELETE and TRUNCATE', async () => {
      const v = variant();
      const written = await (await v.seller()).write(1_000n);
      const recordId = written.ok ? written.value.recordId : null;
      const owner = new Client({ connectionString: ownerTestDatabaseUrl() });
      await owner.connect();
      const ownerState = async (text: string, values: unknown[] = []): Promise<string | null> => {
        await owner.query('BEGIN');
        try {
          await owner.query(text, values);
          return null;
        } catch (error) {
          return (error as { code?: string }).code ?? 'unknown';
        } finally {
          await owner.query('ROLLBACK');
        }
      };
      try {
        // The grants stop the application role first; the triggers hold for the owner too.
        expect(
          await ownerState(
            `UPDATE pricing.first_price_checks SET outcome = 'within'
           WHERE market_id = $1 AND record_id = $2`,
            [code, recordId],
          ),
        ).toBe('23001');
        expect(
          await ownerState(
            `DELETE FROM pricing.first_price_checks WHERE market_id = $1 AND record_id = $2`,
            [code, recordId],
          ),
        ).toBe('23001');
        expect(await ownerState(`TRUNCATE pricing.first_price_checks CASCADE`)).toBe('23001');
      } finally {
        await owner.end();
      }
    });
  },
);
