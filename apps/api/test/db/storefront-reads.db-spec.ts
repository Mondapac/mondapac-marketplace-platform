import { randomBytes } from 'node:crypto';
import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { CategoryTreeQuery } from '../../src/modules/catalog/application/use-cases/category-tree.use-case';
import { PlatformCategory } from '../../src/modules/catalog/domain/platform-category';
import { ConfigCatalogMarketPolicy } from '../../src/modules/catalog/infrastructure/config-catalog-market-policy';
import { PrismaCategoryTreeReader } from '../../src/modules/catalog/infrastructure/prisma-category-tree.reader';
import { PrismaPlatformCategoryRepository } from '../../src/modules/catalog/infrastructure/prisma-platform-category.repository';
import { BestSellingOffersQuery } from '../../src/modules/ordering/application/use-cases/best-selling-offers.use-case';
import type { OrderState } from '../../src/modules/ordering/domain/order';
import { PrismaOrderRepository } from '../../src/modules/ordering/infrastructure/prisma-order.repository';
import { PrismaSalesRankingReader } from '../../src/modules/ordering/infrastructure/prisma-sales-ranking.reader';
import { SetRegularPrice } from '../../src/modules/pricing/application/use-cases/set-regular-price.use-case';
import { SetSpecialPrice } from '../../src/modules/pricing/application/use-cases/set-special-price.use-case';
import { SpecialsInForceQuery } from '../../src/modules/pricing/application/use-cases/specials-in-force.use-case';
import { WithdrawSpecialPrice } from '../../src/modules/pricing/application/use-cases/withdraw-special-price.use-case';
import { PRICING_AUDIT_ACTIONS } from '../../src/modules/pricing/domain/audit';
import { PRICING_EVENTS } from '../../src/modules/pricing/domain/events';
import { ConfigPricingPolicyProvider } from '../../src/modules/pricing/infrastructure/config-pricing-policy-provider';
import { PrismaPriceSeriesRepository } from '../../src/modules/pricing/infrastructure/prisma-price-series.repository';
import { PrismaSpecialsInForceReader } from '../../src/modules/pricing/infrastructure/prisma-specials-in-force.reader';
import { PrismaWriteRateCounterRepository } from '../../src/modules/pricing/infrastructure/prisma-write-rate-counter.repository';
import { PrismaWriteRefusalThrottleRepository } from '../../src/modules/pricing/infrastructure/prisma-write-refusal-throttle.repository';
import type { OfferDocument } from '../../src/modules/search/domain/offer-document';
import { ConfigSearchPolicy } from '../../src/modules/search/infrastructure/config-search-policy';
import { PrismaOfferDocumentRepository } from '../../src/modules/search/infrastructure/prisma-offer-document.repository';
import { PrismaShelfDocumentsReader } from '../../src/modules/search/infrastructure/prisma-shelf-documents.reader';
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
import { FakeOfferSellUnits } from '../support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  modelMap,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The reads behind the storefront shelves and navigation on PostgreSQL, as the application role,
// for both Market fixtures: the live category tree (catalog), the best sellers (ordering), the
// specials in force (pricing) and the shelf documents (search). Each read is Market-scoped (a
// canary in the other Market is never answered). Other specs share the database, so the
// ranking and specials run at a Clock years ahead, where only this spec's rows are in force.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const FUTURE = Temporal.Instant.from('2031-03-10T10:00:00Z');
const BASE = { AU: { currency: 'AUD', base: 10_000n }, ZZ: { currency: 'JPY', base: 1_000n } };

describe.each(TEST_MARKETS)('storefront reads in market %s (database)', (code) => {
  const market: MarketContext = marketOf(code);
  const other: MarketContext = marketOf(otherMarketOf(code));
  const { currency, base } = BASE[code];
  const clock = new FixedClock(FUTURE);
  const ids = new UuidV7IdGenerator(clock);
  const anonymous = testCallContext(market, 'anonymous', `reads-anon-${code.toLowerCase()}abcd`);
  let db: Persistence;
  let owner: Client;

  beforeAll(async () => {
    db = createPersistence({ pause: () => Promise.resolve() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });
  beforeEach(() => clock.set(FUTURE));

  const value = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };

  describe('category tree (catalog)', () => {
    const policy = new ConfigCatalogMarketPolicy(markets);

    const addCategory = async (
      target: MarketContext,
      parentId: Id<'Category'> | null,
      names: { locale: string; name: string }[],
    ): Promise<{ id: Id<'Category'>; slug: string }> => {
      const slug = `reads-${randomBytes(5).toString('hex')}`;
      const created = PlatformCategory.create({
        id: ids.next<'Category'>(),
        revisionId: ids.next<'CategoryRevision'>(),
        marketId: target.marketId,
        parentId,
        verticalRootCode: null,
        slug,
        names,
        createdByKind: 'seed',
        now: clock.now(),
      });
      if (!created.ok) throw new Error(created.error.code);
      await value(target, () =>
        new PrismaPlatformCategoryRepository(db.service).add(target, created.value),
      );
      return { id: created.value.state.id, slug };
    };

    it('answers the live tree: archived ancestors skipped, default-locale names, Market only', async () => {
      const locale = policy.locales(market).default;
      const root = await addCategory(market, null, [
        { locale: 'zz-Latn', name: 'Fallback' },
        { locale, name: 'Pantry' },
      ]);
      const archived = await addCategory(market, root.id, [{ locale, name: 'Old shelf' }]);
      const leaf = await addCategory(market, archived.id, [{ locale, name: 'Spices' }]);
      const canary = await addCategory(other, null, [{ locale, name: 'Canary' }]);
      await owner.query(
        `UPDATE catalog.platform_categories SET status = 'archived' WHERE market_id = $1 AND id = $2`,
        [code, archived.id],
      );

      const result = await new CategoryTreeQuery(gate, {
        unitOfWork: db.unitOfWork,
        treeReader: new PrismaCategoryTreeReader(db.service),
        policy,
      }).execute(anonymous, {});

      if (!result.ok) throw new Error(result.error.code);
      expect(result.value.locale).toBe(locale);
      const bySlug = new Map(result.value.categories.map((c) => [c.slug, c]));
      expect(bySlug.get(root.slug)).toMatchObject({
        id: root.id,
        parentId: null,
        name: 'Pantry',
        depth: 0,
      });
      expect(bySlug.get(leaf.slug)).toMatchObject({ parentId: root.id, name: 'Spices', depth: 1 });
      expect(bySlug.has(archived.slug)).toBe(false);
      expect(bySlug.has(canary.slug)).toBe(false);
    });
  });

  describe('best sellers (ordering)', () => {
    let orders: PrismaOrderRepository;
    beforeAll(() => {
      orders = new PrismaOrderRepository(db.service);
    });

    /** An order with one line per Offer; confirmed `ago` before now when `confirmed`. */
    const order = async (
      target: MarketContext,
      offerIds: readonly Id<'Offer'>[],
      options: { confirmed: boolean; ago?: Temporal.DurationLike },
    ): Promise<void> => {
      const at = clock.now().subtract(options.ago ?? { hours: 1 });
      const orderId = ids.next<'Order'>();
      const sellerOrderId = ids.next<'SellerOrder'>();
      const targetCurrency = target.marketId === 'AU' ? 'AUD' : 'JPY';
      const state: OrderState = {
        id: orderId,
        marketId: target.marketId,
        accountId: ids.next<'Account'>(),
        status: 'pending-payment',
        cancelReason: null,
        paymentState: 'none',
        total: money(1000n * BigInt(offerIds.length), targetCurrency),
        reservationId: ids.next<'Reservation'>(),
        stripeIdempotencyKey: `checkout-${orderId}`,
        stripeSessionId: null,
        stripePaymentIntentId: null,
        paymentExpiresAt: at.add({ minutes: 30 }),
        createdAt: at,
        confirmedAt: null,
        cancelledAt: null,
        version: 1,
        taxStrategyId: null,
        shipToSealed: null,
        sellerOrders: [
          {
            id: sellerOrderId,
            sellerId: ids.next<'Seller'>(),
            subtotal: 1000n * BigInt(offerIds.length),
            shipping: 0n,
            shippingTaxRateBps: null,
            shippingTax: null,
            shippingTaxInclusive: null,
            total: 1000n * BigInt(offerIds.length),
            fulfilment: 'to-ship',
            carrier: null,
            trackingRef: null,
            shippedAt: null,
            deliveredAt: null,
            inventoryRecordedAt: null,
            ledgerState: 'pending',
          },
        ],
        lines: offerIds.map((offerId) => ({
          id: ids.next<'OrderLine'>(),
          sellerOrderId,
          offerId,
          variantId: ids.next<'Variant'>(),
          quantity: 1,
          unitPrice: money(1000n, targetCurrency),
          lineAmount: 1000n,
          taxInclusive: true,
          reservationLineId: ids.next<'ReservationLine'>(),
          commissionRateBps: 1500,
          taxRateBps: 1000,
          taxAmount: 91n,
          taxCategoryCode: 'taxable',
        })),
      };
      await value(target, () => orders.insert(target, state));
      if (!options.confirmed) return;
      await value(target, () =>
        orders.save(target, {
          ...state,
          status: 'confirmed',
          paymentState: 'captured',
          stripePaymentIntentId: `pi_test_${orderId}`,
          confirmedAt: at.add({ minutes: 1 }),
        }),
      );
    };

    it('ranks Offers by paid order lines in the last 30 days, ties by id, Market only', async () => {
      const [top, second, tieA, tieB, unpaid, old] = Array.from({ length: 6 }, () =>
        ids.next<'Offer'>(),
      );
      for (let n = 0; n < 3; n += 1) await order(market, [top!], { confirmed: true });
      await order(market, [second!, tieA!], { confirmed: true });
      await order(market, [second!, tieB!], { confirmed: true });
      for (let n = 0; n < 5; n += 1) await order(market, [unpaid!], { confirmed: false });
      for (let n = 0; n < 5; n += 1)
        await order(market, [old!], { confirmed: true, ago: { hours: 31 * 24 } });
      for (let n = 0; n < 5; n += 1) await order(other, [top!, unpaid!], { confirmed: true });

      const result = await new BestSellingOffersQuery(gate, {
        unitOfWork: db.unitOfWork,
        ranking: new PrismaSalesRankingReader(db.service),
        clock,
      }).execute(anonymous, { limit: 50 });

      if (!result.ok) throw new Error(result.error.code);
      // The other Market's run writes its canaries at the same Clock: keep this run's Offers.
      const mine = new Set([top, second, tieA, tieB, unpaid, old]);
      const ties = [tieA!, tieB!].sort();
      expect(result.value.filter((offerId) => mine.has(offerId))).toEqual([top, second, ...ties]);
    });
  });

  describe('specials in force (pricing)', () => {
    const policies = new ConfigPricingPolicyProvider(markets);
    let offers: FakeOfferSellUnits;
    let series: PrismaPriceSeriesRepository;
    let audit: AuditWriter;

    beforeAll(() => {
      const catalogue = new AuditActionCatalogue();
      catalogue.register('pricing', PRICING_AUDIT_ACTIONS);
      catalogue.seal();
      audit = PersistenceModule.auditWriterFor('pricing').useFactory(
        catalogue,
        ids,
        clock,
        NO_PERMISSION_KEYS,
      ) as AuditWriter;
      series = new PrismaPriceSeriesRepository(db.service);
      offers = new FakeOfferSellUnits();
    });

    const writeDeps = () => {
      const events = new EventCatalogue();
      events.register('pricing', PRICING_EVENTS);
      events.seal();
      return {
        unitOfWork: db.unitOfWork,
        series,
        throttles: new PrismaWriteRefusalThrottleRepository(db.service),
        counters: new PrismaWriteRateCounterRepository(db.service),
        offers,
        policies,
        audit,
        outbox: new PrismaOutboxWriterFactory(
          modelMap,
          db.service,
          events,
          ids,
          NO_PERMISSION_KEYS,
        ).forModule('pricing'),
        clock,
        ids,
      };
    };

    /** A seller's (Offer, Variant) with a regular price, and helpers for its special. */
    const unit = async () => {
      const sellerId = ids.next<'Seller'>();
      const offerId = ids.next<'Offer'>();
      const variantId = ids.next<'Variant'>();
      const context: CallContext = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId,
        }),
        `reads-db-${randomBytes(6).toString('hex')}`,
      );
      offers.put(market, offerId, {
        sellerId,
        productId: ids.next<'Product'>(),
        deleted: false,
        priceableVariantIds: [variantId],
      });
      const regular = await new SetRegularPrice(gate, writeDeps()).execute(context, {
        offerId,
        variantId,
        price: { amount: base.toString(), currency },
        expectedVersion: null,
      });
      if (!regular.ok) throw new Error(regular.error.code);
      const setSpecial = async (amount: bigint, endsAt: Temporal.Instant, version: number) => {
        clock.set(clock.now().add({ seconds: 5 }));
        const result = await new SetSpecialPrice(gate, writeDeps()).execute(context, {
          offerId,
          variantId,
          price: { amount: amount.toString(), currency },
          startsAt: null,
          endsAt: endsAt.toString(),
          expectedVersion: version,
        });
        if (!result.ok) throw new Error(result.error.code);
      };
      const withdraw = async (version: number) => {
        clock.set(clock.now().add({ seconds: 5 }));
        const result = await new WithdrawSpecialPrice(gate, writeDeps()).execute(context, {
          offerId,
          variantId,
          expectedVersion: version,
        });
        if (!result.ok) throw new Error(result.error.code);
      };
      return { offerId, variantId, setSpecial, withdraw };
    };

    it('answers the keys on special now with both prices, newest first, never ended ones', async () => {
      const ends = FUTURE.add({ hours: 72 });
      const older = await unit();
      await older.setSpecial((base * 9n) / 10n, ends, 2);
      const newer = await unit();
      await newer.setSpecial((base * 8n) / 10n, ends, 2);
      const withdrawn = await unit();
      await withdrawn.setSpecial((base * 7n) / 10n, ends, 2);
      await withdrawn.withdraw(3);
      const plain = await unit();

      const read = () =>
        new SpecialsInForceQuery(gate, {
          unitOfWork: db.unitOfWork,
          specials: new PrismaSpecialsInForceReader(db.service),
          series,
          clock,
        }).execute(anonymous, { limit: 50 });
      const now = await read();

      if (!now.ok) throw new Error(now.error.code);
      expect(now.value.map((s) => s.offerId)).toEqual([newer.offerId, older.offerId]);
      expect(now.value[0]).toEqual({
        offerId: newer.offerId,
        variantId: newer.variantId,
        price: { amount: (base * 8n) / 10n, currency },
        regularPrice: { amount: base, currency },
        taxInclusive: expect.any(Boolean) as unknown,
        endsAt: ends,
      });
      expect(now.value.map((s) => s.offerId)).not.toContain(plain.offerId);

      clock.set(ends.add({ seconds: 1 }));
      const later = await read();
      expect(later.ok && later.value.map((s) => s.offerId)).toEqual([]);
    });

    it('is not answered for another Market and refuses a limit out of range', async () => {
      const mine = await unit();
      await mine.setSpecial((base * 9n) / 10n, FUTURE.add({ hours: 24 }), 2);
      const query = new SpecialsInForceQuery(gate, {
        unitOfWork: db.unitOfWork,
        specials: new PrismaSpecialsInForceReader(db.service),
        series,
        clock,
      });

      const elsewhere = await query.execute(
        testCallContext(other, 'anonymous', `reads-other-${code.toLowerCase()}abcd`),
        { limit: 50 },
      );
      const refused = await query.execute(anonymous, { limit: 201 });

      expect(elsewhere.ok && elsewhere.value.map((s) => s.offerId)).not.toContain(mine.offerId);
      expect(refused).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'limit', code: 'range' }] },
      });
    });
  });

  describe('shelf documents (search)', () => {
    const settings = new ConfigSearchPolicy(markets).settings(market);
    const doc = (target: MarketContext, name: string): OfferDocument => ({
      offerId: ids.next<'Offer'>(),
      productId: ids.next<'Product'>(),
      sellerId: ids.next<'Seller'>(),
      locale: new ConfigSearchPolicy(markets).settings(target).locale,
      name,
      shortText: null,
      categoryIds: [],
      textSearchConfig: new ConfigSearchPolicy(markets).settings(target).textSearchConfig,
    });

    it('reads documents by Offer id and in browse order, in this Market only', async () => {
      const documents = new PrismaOfferDocumentRepository(db.service);
      const reader = new PrismaShelfDocumentsReader(db.service);
      const a = doc(market, 'Reads shelf apple');
      const b = doc(market, 'Reads shelf banana');
      const canary = doc(other, 'Reads shelf canary');
      await value(market, async () => {
        await documents.upsert(market, a, clock.now());
        await documents.upsert(market, b, clock.now());
      });
      await value(other, () => documents.upsert(other, canary, clock.now()));

      const found = await value(market, () =>
        reader.byOfferIds(market, [a.offerId, b.offerId, canary.offerId]),
      );
      const browsed = await value(market, () => reader.browseAll(market, 500));

      expect(found.map((h) => h.offerId).sort()).toEqual([a.offerId, b.offerId].sort());
      expect(found.find((h) => h.offerId === a.offerId)).toMatchObject({
        name: 'Reads shelf apple',
        rank: 0,
      });
      expect(browsed.map((h) => h.offerId)).not.toContain(canary.offerId);
      const mine = browsed.map((h) => h.offerId).filter((o) => o === a.offerId || o === b.offerId);
      expect(mine).toEqual([a.offerId, b.offerId]);
      expect(settings.textSearchConfig).toBeTruthy();
    });
  });
});
