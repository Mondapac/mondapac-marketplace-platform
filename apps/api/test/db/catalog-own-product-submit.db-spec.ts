import { randomUUID } from 'node:crypto';
import { Temporal, ok, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { CheckClaimText } from '../../src/modules/catalog/application/claim-text/check-claim-text.service';
import type { AttributeRepository } from '../../src/modules/catalog/application/ports/attribute.repository';
import type { CatalogMarketPolicy } from '../../src/modules/catalog/application/ports/catalog-market-policy';
import { FreezeRevision } from '../../src/modules/catalog/application/revisions/freeze-revision.service';
import { SubmitProduct } from '../../src/modules/catalog/application/revisions/submit-product.service';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { HmacRateCounterKeys } from '../../src/modules/catalog/infrastructure/hmac-rate-counter-keys';
import { CertificationClaimTextMatcher } from '../../src/modules/catalog/infrastructure/certification-claim-text-matcher';
import type { CertificationFacade } from '../../src/modules/certification';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaProductRevisionRepository } from '../../src/modules/catalog/infrastructure/prisma-product-revision.repository';
import { PrismaWorkingCopyRepository } from '../../src/modules/catalog/infrastructure/prisma-working-copy.repository';
import { TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Catalog slice 7 (own-product.submit: the SubmitProduct service as a seller) on PostgreSQL, for both Market fixtures: the submit
// service end to end over the real stores (freeze, claim check, revision rows, product pointer,
// events) and the loss of a race on the revision number mapped to a stale conflict.

const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');
const clock = new FixedClock(T0);
let sequence = 0;
const SELLER = '01990000-0000-7000-8000-00000000b001' as Id<'Seller'>;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)(
  'catalog own product submit in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    let persistence: Persistence;
    let app: Client;
    let products: PrismaProductRepository;
    let copies: PrismaWorkingCopyRepository;
    let revisions: PrismaProductRevisionRepository;
    let appended: string[];
    let submit: SubmitProduct;
    let familyRevisionId: string;
    let categoryId: string;

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
      }),
      maxVariantsPerProduct: () => 10,
      productTypes: () => ['simple', 'configurable'],
      defaultFamily: () => 'default',
      conditions: () => ['new'],
      sellFromCatalogue: () => Promise.resolve(true),
      sellerCanCreateProduct: () => Promise.resolve(true),
      approvalRequired: () => Promise.resolve(true),
    };

    async function insert(table: string, row: Record<string, unknown>) {
      const columns = Object.keys(row);
      await app.query(
        `INSERT INTO catalog.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    }
    const base = { market_id: market.marketId, tenant_id: market.tenantId };

    beforeAll(async () => {
      persistence = createPersistence();
      app = new Client({ connectionString: testDatabaseUrl() });
      await app.connect();
      products = new PrismaProductRepository(persistence.service);
      copies = new PrismaWorkingCopyRepository(persistence.service);
      revisions = new PrismaProductRevisionRepository(persistence.service);

      const familyId = uuid7();
      familyRevisionId = uuid7();
      await insert('attribute_families', {
        id: familyId,
        ...base,
        code: `f-${randomUUID().slice(0, 10)}`,
        status: 'active',
        created_by_kind: 'seed',
        version: 1,
        created_at: T0.toString(),
      });
      await insert('attribute_family_revisions', {
        id: familyRevisionId,
        ...base,
        family_id: familyId,
        revision_no: 1,
        groups: '[]',
        author_kind: 'seed',
        created_at: T0.toString(),
      });
      await app.query(
        `INSERT INTO catalog.category_trees (market_id, tenant_id, version) VALUES ($1, $2, 1)
         ON CONFLICT DO NOTHING`,
        [market.marketId, market.tenantId],
      );
      categoryId = uuid7();
      await insert('platform_categories', {
        id: categoryId,
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

      const attributes = {
        loadSchema: () =>
          Promise.resolve({
            schemaRef: { familyCode: 'default', familyRevisionId, definitionRevisionIds: [] },
            fields: [],
          }),
      } as unknown as AttributeRepository;
      const facade = {
        matchClaimTerms: (context, texts) =>
          persistence.unitOfWork.run(
            context.market,
            () =>
              Promise.resolve(
                ok(
                  texts.map((item) =>
                    item.text.includes('halal')
                      ? [{ typeCode: 'halal' as never, pass: 'token' as const, span: null }]
                      : [],
                  ),
                ),
              ),
            { readOnly: true },
          ),
      } satisfies Pick<CertificationFacade, 'matchClaimTerms'> as unknown as CertificationFacade;
      const check = new CheckClaimText({
        unitOfWork: persistence.unitOfWork,
        // The real adapter over a facade that opens a read-only unit of its own, as
        // `certification.matchClaimTerms` does: a call inside an open unit would throw
        // `NestedUnitOfWorkError`.
        matcher: new CertificationClaimTextMatcher(facade),
        counters: {
          reserve: () => Promise.reject(new Error('submit spends no counter')),
          purgeStartedBefore: () => Promise.resolve(0),
        },
        counterKeys: new HmacRateCounterKeys(new Uint8Array(32).fill(5)),
        policy,
        clock,
      });
      submit = new SubmitProduct({
        unitOfWork: persistence.unitOfWork,
        products,
        workingCopies: copies,
        revisions,
        freeze: new FreezeRevision({
          attributes,
          policy,
          handlerFor: (typeCode) => (typeCode === 'simple' ? simpleProductType : undefined),
        }),
        check,
        policy,
        outbox: {
          append: (_context, events) => {
            appended.push(...events.map((event) => event.type));
            return Promise.resolve();
          },
        },
        clock,
        ids: { next: <K extends string>() => uuid7() as Id<K> },
      });
    });
    beforeEach(() => {
      appended = [];
    });
    afterAll(async () => {
      await app.end();
      await persistence.close();
    });

    const inUnit = <T>(work: () => Promise<T>): Promise<T> =>
      persistence.unitOfWork
        .run(market, async () => ({ ok: true as const, value: await work() }))
        .then((result) => {
          if (!result.ok) throw new Error('unit failed');
          return result.value;
        });

    async function draftedProduct(): Promise<Product> {
      const created = Product.create({
        id: uuid7() as Id<'Product'>,
        marketId: market.marketId,
        scope: 'SELLER',
        sellerId: SELLER,
        handler: simpleProductType,
        familyCode: 'default',
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
      return created.value;
    }

    const sellerContext = (sellerId: Id<'Seller'> = SELLER) =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: uuid7() as Id<'Account'>,
          sessionId: uuid7() as Id<'Session'>,
          sellerId,
        }),
      );

    async function rowCount(table: string, productId: string): Promise<number> {
      const { rows } = await app.query(
        `SELECT count(*)::int AS n FROM catalog.${table} WHERE product_id = $1`,
        [productId],
      );
      return (rows[0] as { n: number }).n;
    }

    it('stores a seller revision as pending: the pending pointer moves, the published one does not', async () => {
      const product = await draftedProduct();
      const result = await submit.execute(sellerContext(), {
        productId: product.state.id,
        replacePending: false,
      });
      if (!result.ok) throw new Error(result.error.code);
      expect(result.value).toMatchObject({ revisionNo: 1, published: false });

      const stored = await inUnit(() => products.findById(market, product.state.id));
      expect(stored?.state).toMatchObject({
        publishedRevisionId: null,
        pendingRevisionId: result.value.revisionId,
        status: 'unpublished',
      });
      const revision = await inUnit(() =>
        revisions.find(market, product.state.id, result.value.revisionId),
      );
      expect(revision).toMatchObject({
        revisionNo: 1,
        kind: 'submission',
        authorKind: 'seller',
        baseRevisionId: null,
        sensitive: true,
      });
      expect(appended).toContain('catalog.product-revision-submitted.v1');
      expect(appended).not.toContain('catalog.product-revision-published.v1');
    });

    it('refuses a second submit while one is pending, then supersedes it with replacePending', async () => {
      const product = await draftedProduct();
      const first = await submit.execute(sellerContext(), {
        productId: product.state.id,
        replacePending: false,
      });
      if (!first.ok) throw new Error(first.error.code);
      const refused = await submit.execute(sellerContext(), {
        productId: product.state.id,
        replacePending: false,
      });
      expect(!refused.ok && refused.error.code).toBe('revision.pending-exists');
      expect(await rowCount('product_revisions', product.state.id)).toBe(1);

      const second = await submit.execute(sellerContext(), {
        productId: product.state.id,
        replacePending: true,
      });
      if (!second.ok) throw new Error(second.error.code);
      expect(second.value.revisionNo).toBe(2);
      const stored = await inUnit(() => products.findById(market, product.state.id));
      expect(stored?.state.pendingRevisionId).toBe(second.value.revisionId);
    });

    it('answers another seller as product.not-found and stores nothing', async () => {
      const product = await draftedProduct();
      const other = '01990000-0000-7000-8000-00000000b002' as Id<'Seller'>;
      const result = await submit.execute(sellerContext(other), {
        productId: product.state.id,
        replacePending: false,
      });
      expect(!result.ok && result.error.code).toBe('product.not-found');
      expect(await rowCount('product_revisions', product.state.id)).toBe(0);
      expect(appended).toEqual([]);
    });

    it('refuses a matching text and leaves no revision row and no event', async () => {
      const product = await draftedProduct();
      await inUnit(() =>
        copies.save(market, {
          productId: product.state.id,
          content: {
            texts: { en: { name: 'Dates', description: 'halal dates' } },
            categoryIds: [categoryId],
            taxCategoryCode: 't1',
          },
          contentSchemaVersion: 1,
          baseRevisionId: null,
          lastSavedAt: T0,
          lastSavedByAccountId: uuid7() as Id<'Account'>,
        }),
      );
      const result = await submit.execute(sellerContext(), {
        productId: product.state.id,
        replacePending: false,
      });
      expect(!result.ok && result.error.code).toBe('claim-text.refused');
      expect(await rowCount('product_revisions', product.state.id)).toBe(0);
      expect(appended).toEqual([]);
    });
  },
);
