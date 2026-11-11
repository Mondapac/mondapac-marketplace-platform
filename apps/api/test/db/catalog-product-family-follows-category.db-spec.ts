import { randomUUID } from 'node:crypto';
import { Temporal, ok, uuidV7 } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { ProductFamilyResolver } from '../../src/modules/catalog/application/attributes/product-family-resolver';
import { CheckClaimText } from '../../src/modules/catalog/application/claim-text/check-claim-text.service';
import type { CatalogMarketPolicy } from '../../src/modules/catalog/application/ports/catalog-market-policy';
import { FreezeRevision } from '../../src/modules/catalog/application/revisions/freeze-revision.service';
import { SubmitProduct } from '../../src/modules/catalog/application/revisions/submit-product.service';
import { ProductRevisionRequestChanges } from '../../src/modules/catalog/application/use-cases/product-revision-request-changes.use-case';
import { CategoryAttributeLink } from '../../src/modules/catalog/domain/category-attribute-link';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { CertificationClaimTextMatcher } from '../../src/modules/catalog/infrastructure/certification-claim-text-matcher';
import { HmacRateCounterKeys } from '../../src/modules/catalog/infrastructure/hmac-rate-counter-keys';
import { PrismaAttributeAdminReader } from '../../src/modules/catalog/infrastructure/prisma-attribute-admin.reader';
import { PrismaAttributeRepository } from '../../src/modules/catalog/infrastructure/prisma-attribute.repository';
import { PrismaCategoryAttributeLinkStore } from '../../src/modules/catalog/infrastructure/prisma-category-attribute-link.store';
import { PrismaCategoryTreeReader } from '../../src/modules/catalog/infrastructure/prisma-category-tree.reader';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaProductRevisionRepository } from '../../src/modules/catalog/infrastructure/prisma-product-revision.repository';
import { PrismaTagReevaluationRequests } from '../../src/modules/catalog/infrastructure/prisma-tag-reevaluation-requests';
import { PrismaWorkingCopyRepository } from '../../src/modules/catalog/infrastructure/prisma-working-copy.repository';
import type { CertificationFacade } from '../../src/modules/certification';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// CAT-10 (attributes plan A4, decision ت۱۰) on PostgreSQL, for both Market fixtures, with the real
// resolver over the real tree, links and feature sets: a submit moves the product to the feature
// set its primary category holds (column and event), a reject puts the column back (the guard of
// migration #709 allows it only with a revision-pointer move), and a bare change of the column is
// refused by the database.

const T0 = Temporal.Instant.from('2026-11-06T00:00:00Z');
const T1 = Temporal.Instant.from('2026-11-06T01:00:00Z');
const clock = new FixedClock(T0);
let sequence = 0;
const SELLER = '01990000-0000-7000-8000-00000000b301' as Id<'Seller'>;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);

describe.each(TEST_MARKETS)(
  'catalog product feature set follows its category in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    let persistence: Persistence;
    let app: Client;
    let products: PrismaProductRepository;
    let copies: PrismaWorkingCopyRepository;
    let appended: string[];
    let submit: SubmitProduct;
    let requestChanges: ProductRevisionRequestChanges;
    let familyA: { id: string; code: string };
    let familyB: { id: string; code: string };
    let categoryA: string;
    let categoryB: string;

    const defaults = () => familyA.code;
    const policy: CatalogMarketPolicy = {
      taxCategoryCodes: () => ['t1'],
      locales: () => ({ default: 'en', supported: ['en'] }),
      sensitiveChanges: () => ({
        platformCategories: true,
        taxCategory: true,
        name: true,
        primaryImage: true,
        anyImage: false,
        variantRemoved: true,
        gtinChanged: true,
      }),
      maxVariantsPerProduct: () => 10,
      maxVariantAttributes: () => 2,
      units: () => [],
      maxCategoryDepth: () => 4,
      maxCategoryChangeTags: () => 50_000,
      maxCategoryImportRows: () => 2000,
      maxCategoryImportBytes: () => 5 * 1024 * 1024,
      productTypes: () => ['simple', 'configurable'],
      defaultFamily: defaults,
      conditions: () => ['new'],
      sellFromCatalogue: () => Promise.resolve(true),
      sellerCanCreateProduct: () => Promise.resolve(true),
      approvalRequired: () => Promise.resolve(true),
    };
    const base = { market_id: market.marketId, tenant_id: market.tenantId };

    async function insert(table: string, row: Record<string, unknown>) {
      const columns = Object.keys(row);
      await app.query(
        `INSERT INTO catalog.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    }
    async function family(): Promise<{ id: string; code: string }> {
      const id = uuid7();
      const fam = `f-${randomUUID().slice(0, 10)}`;
      await insert('attribute_families', {
        id,
        ...base,
        code: fam,
        status: 'active',
        created_by_kind: 'seed',
        version: 1,
        created_at: T0.toString(),
      });
      const revisionId = uuid7();
      await insert('attribute_family_revisions', {
        id: revisionId,
        ...base,
        family_id: id,
        revision_no: 1,
        groups: '[]',
        author_kind: 'seed',
        created_at: T0.toString(),
      });
      await app.query(
        `UPDATE catalog.attribute_families SET published_revision_id = $3
          WHERE market_id = $1 AND id = $2`,
        [market.marketId, id, revisionId],
      );
      return { id, code: fam };
    }
    async function category(): Promise<string> {
      const id = uuid7();
      await insert('platform_categories', {
        id,
        ...base,
        slug: `s-${randomUUID().slice(0, 12)}`,
        parent_id: null,
        status: 'active',
        merged_into_id: null,
        vertical_root_code: null,
        created_by_kind: 'seed',
        version: 1,
        created_at: T0.toString(),
      });
      return id;
    }

    beforeAll(async () => {
      persistence = createPersistence();
      app = new Client({ connectionString: testDatabaseUrl() });
      await app.connect();
      products = new PrismaProductRepository(persistence.service);
      copies = new PrismaWorkingCopyRepository(persistence.service);
      const revisions = new PrismaProductRevisionRepository(persistence.service);
      await app.query(
        `INSERT INTO catalog.category_trees (market_id, tenant_id, version) VALUES ($1, $2, 1)
         ON CONFLICT DO NOTHING`,
        [market.marketId, market.tenantId],
      );
      familyA = await family();
      familyB = await family();
      categoryA = await category();
      categoryB = await category();
      // Category B holds feature set B; category A holds none, so it gets the Market default (A).
      const link = CategoryAttributeLink.create({
        marketId: market.marketId,
        categoryId: categoryB as Id<'Category'>,
        revisionId: uuid7() as Id<'CategoryAttributeLinkRevision'>,
        familyId: familyB.id as Id<'AttributeFamily'>,
        filters: [],
        now: T0,
      });
      if (!link.ok) throw new Error(link.error.code);
      await persistence.unitOfWork.run(market, async () =>
        ok(
          await new PrismaCategoryAttributeLinkStore(persistence.service).add(
            market,
            link.value,
            uuid7() as Id<'Account'>,
          ),
        ),
      );

      const resolver = new ProductFamilyResolver({
        treeReader: new PrismaCategoryTreeReader(persistence.service),
        linkStore: new PrismaCategoryAttributeLinkStore(persistence.service),
        attributeAdminReader: new PrismaAttributeAdminReader(persistence.service),
        policy,
      });
      const attributes = new PrismaAttributeRepository(persistence.service);
      const facade = {
        matchClaimTerms: (context, texts) =>
          persistence.unitOfWork.run(
            context.market,
            () => Promise.resolve(ok(texts.map(() => []))),
            { readOnly: true },
          ),
      } satisfies Pick<CertificationFacade, 'matchClaimTerms'> as unknown as CertificationFacade;
      const check = new CheckClaimText({
        unitOfWork: persistence.unitOfWork,
        matcher: new CertificationClaimTextMatcher(facade),
        counters: {
          reserve: () => Promise.reject(new Error('submit spends no counter')),
          purgeStartedBefore: () => Promise.resolve(0),
        },
        counterKeys: new HmacRateCounterKeys(new Uint8Array(32).fill(5)),
        policy,
        clock,
      });
      const outbox = {
        append: (_context: CallContext, events: readonly { type: string }[]) => {
          appended.push(...events.map((event) => event.type));
          return Promise.resolve();
        },
      };
      submit = new SubmitProduct({
        unitOfWork: persistence.unitOfWork,
        products,
        workingCopies: copies,
        revisions,
        freeze: new FreezeRevision({
          familyResolver: resolver,
          attributes,
          policy,
          handlerFor: (typeCode) => (typeCode === 'simple' ? simpleProductType : undefined),
        }),
        check,
        policy,
        outbox,
        clock,
        ids: { next: <K extends string>() => uuid7() as Id<K> },
        offers: new PrismaOfferRepository(persistence.service, {
          next: <K extends string>() => uuid7() as Id<K>,
        }),
        requests: new PrismaTagReevaluationRequests(persistence.service),
      });
      requestChanges = new ProductRevisionRequestChanges(gate, {
        unitOfWork: persistence.unitOfWork,
        products,
        revisions,
        attributes,
        policy,
        outbox,
        clock: new FixedClock(T1),
      });
    });
    beforeEach(() => {
      appended = [];
    });
    afterAll(async () => {
      await app.end();
      await persistence.close();
    });

    const inUnit = <T>(work: () => Promise<T>, readOnly = false): Promise<T> =>
      persistence.unitOfWork
        .run(market, async () => ({ ok: true as const, value: await work() }), { readOnly })
        .then((result) => {
          if (!result.ok) throw new Error('unit failed');
          return result.value;
        });

    async function draftedProduct(categoryId: string): Promise<Id<'Product'>> {
      const created = Product.create({
        id: uuid7() as Id<'Product'>,
        marketId: market.marketId,
        scope: 'SELLER',
        sellerId: SELLER,
        handler: simpleProductType,
        familyCode: familyA.code,
        productCode: `X${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
        variantId: uuid7() as Id<'Variant'>,
        now: T0,
      });
      if (!created.ok) throw new Error(created.error.code);
      await inUnit(() => products.add(market, created.value));
      await inUnit(() =>
        copies.save(market, {
          productId: created.value.state.id,
          content: {
            texts: { en: { name: 'Dates', description: 'Sweet and soft' } },
            categoryIds: [categoryId],
            taxCategoryCode: 't1',
          },
          contentSchemaVersion: 1,
          baseRevisionId: null,
          lastSavedAt: T0,
          lastSavedByAccountId: uuid7() as Id<'Account'>,
        }),
      );
      return created.value.state.id;
    }
    const sellerContext = () =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: uuid7() as Id<'Account'>,
          sessionId: uuid7() as Id<'Session'>,
          sellerId: SELLER,
        }),
      );
    const adminContext = () =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: uuid7() as Id<'Account'>,
          sessionId: uuid7() as Id<'Session'>,
          sellerId: null,
        }),
      );
    async function column(productId: Id<'Product'>): Promise<string> {
      const { rows } = await app.query(
        'SELECT family_code FROM catalog.products WHERE market_id = $1 AND id = $2',
        [market.marketId, productId],
      );
      return (rows[0] as { family_code: string }).family_code;
    }

    it('moves the column and writes the event on a submit, and puts the column back on a reject', async () => {
      const productId = await draftedProduct(categoryB);
      expect(await column(productId)).toBe(familyA.code);

      const result = await submit.execute(sellerContext(), { productId, replacePending: false });
      if (!result.ok) throw new Error(result.error.code);
      expect(await column(productId)).toBe(familyB.code);
      expect(appended).toContain('catalog.product-family-changed.v1');

      const stored = await inUnit(() => products.findById(market, productId), true);
      appended = [];
      const sent = await requestChanges.execute(adminContext(), {
        productId,
        revisionId: result.value.revisionId,
        version: stored!.state.version,
        reasonCode: 'description-claim',
      });
      expect(sent).toEqual({ ok: true, value: {} });
      // Never published: back to the Market default.
      expect(await column(productId)).toBe(familyA.code);
      expect(appended).toContain('catalog.product-family-changed.v1');
    });

    it('keeps the column when the primary category holds the same feature set', async () => {
      const productId = await draftedProduct(categoryA);
      const result = await submit.execute(sellerContext(), { productId, replacePending: false });
      if (!result.ok) throw new Error(result.error.code);
      expect(await column(productId)).toBe(familyA.code);
      expect(appended).not.toContain('catalog.product-family-changed.v1');
    });

    it('refuses a change of the column that moves no revision pointer', async () => {
      const productId = await draftedProduct(categoryA);
      await expect(
        app.query('UPDATE catalog.products SET family_code = $3 WHERE market_id = $1 AND id = $2', [
          market.marketId,
          productId,
          familyB.code,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await column(productId)).toBe(familyA.code);
    });
  },
);
