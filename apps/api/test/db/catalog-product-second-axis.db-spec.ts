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
import { CheckClaimText } from '../../src/modules/catalog/application/claim-text/check-claim-text.service';
import type { AttributeRepository } from '../../src/modules/catalog/application/ports/attribute.repository';
import type { CatalogMarketPolicy } from '../../src/modules/catalog/application/ports/catalog-market-policy';
import { FreezeRevision } from '../../src/modules/catalog/application/revisions/freeze-revision.service';
import { SubmitProduct } from '../../src/modules/catalog/application/revisions/submit-product.service';
import { ProductRevisionApprove } from '../../src/modules/catalog/application/use-cases/product-revision-approve.use-case';
import { Product } from '../../src/modules/catalog/domain/product';
import { configurableProductType } from '../../src/modules/catalog/domain/product-types/configurable';
import { CertificationClaimTextMatcher } from '../../src/modules/catalog/infrastructure/certification-claim-text-matcher';
import { HmacRateCounterKeys } from '../../src/modules/catalog/infrastructure/hmac-rate-counter-keys';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaProductRevisionRepository } from '../../src/modules/catalog/infrastructure/prisma-product-revision.repository';
import { PrismaWorkingCopyRepository } from '../../src/modules/catalog/infrastructure/prisma-working-copy.repository';
import type { CertificationFacade } from '../../src/modules/certification';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaTagReevaluationRequests } from '../../src/modules/catalog/infrastructure/prisma-tag-reevaluation-requests';
import { ClaimQueryBuilder } from '../../src/modules/catalog/application/tags/claim-query-builder';
import { PrismaCategoryPathsReader } from '../../src/modules/catalog/infrastructure/prisma-category-paths.reader';
import { FakeClaimEvaluator, allowedDecision } from '../support/catalog-tag-fakes';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { testDatabaseUrl } from './test-database';
import { fixedFamilyResolver } from '../support/family-resolver';

// Add a second axis (variants V9b) on PostgreSQL, for both Market fixtures: a Configurable product
// published on one axis is submitted with a second one; the revision is sensitive with the reason
// `axis-added`, waits for review, and after approval the published revision holds two options per
// variant under the same variant ids. A live variant without an option of the new axis refuses the
// submit, and a product on two axes refuses a change of its axes.

const T0 = Temporal.Instant.from('2026-10-16T00:00:00Z');
const T1 = Temporal.Instant.from('2026-10-16T01:00:00Z');
const clock = new FixedClock(T0);
let sequence = 0;
const SELLER = '01990000-0000-7000-8000-00000000b101' as Id<'Seller'>;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const ALL_CHECKS = [
  'photos-no-certification-mark',
  'category-fits',
  'tax-category-fits',
  'not-a-duplicate',
];
const axisField = (code: string, options: string[]) => ({
  code,
  dataType: 'select' as const,
  localizable: false,
  required: false,
  isVariantOption: true,
  material: false,
  claimChecked: false,
  bounds: { options: options.map((option) => ({ code: option, labels: { en: `${option}-en` } })) },
});
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);

describe.each(TEST_MARKETS)(
  'catalog add a second variant axis in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    let persistence: Persistence;
    let app: Client;
    let products: PrismaProductRepository;
    let copies: PrismaWorkingCopyRepository;
    let revisions: PrismaProductRevisionRepository;
    let appended: string[];
    let submit: SubmitProduct;
    let approve: ProductRevisionApprove;
    let offerStore: PrismaOfferRepository;
    let evaluator: FakeClaimEvaluator;
    const certificate = {
      certificateId: uuid7() as Id,
      versionId: uuid7() as Id,
      typeRevisionId: uuid7() as Id,
    };
    let categoryId: string;
    let eligible = true;
    let axisAdded = true;
    let maxAxes = 2;
    let approvalOn = true;
    const reviewClock = new FixedClock(T1);

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
        axisAdded,
      }),
      maxVariantsPerProduct: () => 10,
      maxVariantAttributes: () => maxAxes,
      units: () => [],
      maxCategoryDepth: () => 4,
      maxCategoryChangeTags: () => 50_000,
      productTypes: () => ['simple', 'configurable'],
      defaultFamily: () => 'default',
      conditions: () => ['new'],
      sellFromCatalogue: () => Promise.resolve(true),
      sellerCanCreateProduct: () => Promise.resolve(true),
      approvalRequired: () => Promise.resolve(approvalOn),
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
      offerStore = new PrismaOfferRepository(persistence.service, {
        next: <K extends string>() => uuid7() as Id<K>,
      });
      evaluator = new FakeClaimEvaluator((query) => allowedDecision(query, certificate), []);

      const familyId = uuid7();
      const familyRevisionId = uuid7();
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
            fields: [axisField('size', ['l', 's']), axisField('colour', ['r', 'b'])],
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
        matcher: new CertificationClaimTextMatcher(facade),
        counters: {
          reserve: () => Promise.reject(new Error('review spends no counter')),
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
          familyResolver: fixedFamilyResolver(),
          attributes,
          policy,
          handlerFor: (typeCode) =>
            typeCode === 'configurable' ? configurableProductType : undefined,
          revisions,
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
      approve = new ProductRevisionApprove(gate, {
        unitOfWork: persistence.unitOfWork,
        products,
        revisions,
        eligibility: { isEligible: () => Promise.resolve(eligible) },
        check,
        policy,
        outbox,
        clock: reviewClock,
        offerFinder: offerStore,
        offers: offerStore,
        claims: new ClaimQueryBuilder({
          products,
          revisions,
          categoryPaths: new PrismaCategoryPathsReader(persistence.service),
        }),
        evaluator,
      });
    });
    beforeEach(() => {
      appended = [];
      eligible = true;
      axisAdded = true;
      maxAxes = 2;
      approvalOn = true;
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

    async function saveCopy(
      productId: Id<'Product'>,
      content: Record<string, unknown>,
      baseRevisionId: string | null,
    ) {
      await inUnit(() =>
        copies.save(market, {
          productId,
          content: {
            texts: { en: { name: 'Dates', description: 'Sweet and soft' } },
            categoryIds: [categoryId],
            taxCategoryCode: 't1',
            ...content,
          },
          contentSchemaVersion: 1,
          baseRevisionId: baseRevisionId as Id<'ProductRevision'> | null,
          lastSavedAt: T0,
          lastSavedByAccountId: uuid7() as Id<'Account'>,
        }),
      );
    }

    let VARIANTS: readonly [Id<'Variant'>, Id<'Variant'>];
    const onSize = (variantId: Id<'Variant'>, size: string, colour?: string) => ({
      variantId,
      optionValues: colour === undefined ? { size } : { size, colour },
    });

    async function draftedProduct(scope: 'SELLER' | 'PLATFORM' = 'SELLER'): Promise<Product> {
      const created = Product.create({
        id: uuid7() as Id<'Product'>,
        marketId: market.marketId,
        scope,
        sellerId: scope === 'SELLER' ? SELLER : null,
        handler: configurableProductType,
        familyCode: 'default',
        productCode: `X${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
        variantId: null,
        now: T0,
      });
      if (!created.ok) throw new Error(created.error.code);
      VARIANTS = [uuid7() as Id<'Variant'>, uuid7() as Id<'Variant'>];
      for (const id of VARIANTS)
        created.value.addVariant(id, 100, T0, scope === 'SELLER' ? 'seller' : 'admin');
      await inUnit(() => products.add(market, created.value));
      await saveCopy(
        created.value.state.id,
        { variantAxes: ['size'], variants: [onSize(VARIANTS[0], 'l'), onSize(VARIANTS[1], 's')] },
        null,
      );
      return created.value;
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
    const ADMIN = uuid7() as Id<'Account'>;
    const adminContext = () =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: ADMIN,
          sessionId: uuid7() as Id<'Session'>,
          sellerId: null,
        }),
      );

    async function productRow(productId: string) {
      const { rows } = await app.query(
        `SELECT status, published_revision_id, pending_revision_id, version
           FROM catalog.products WHERE market_id = $1 AND id = $2`,
        [market.marketId, productId],
      );
      return rows[0] as {
        status: string;
        published_revision_id: string | null;
        pending_revision_id: string | null;
        version: number;
      };
    }
    async function revisionRow(revisionId: string) {
      const { rows } = await app.query(
        `SELECT revision_no, sensitive, sensitive_reasons FROM catalog.product_revisions
          WHERE market_id = $1 AND id = $2`,
        [market.marketId, revisionId],
      );
      return rows[0] as { revision_no: number; sensitive: boolean; sensitive_reasons: string[] };
    }
    async function approveRevision(productId: Id<'Product'>, revisionId: Id<'ProductRevision'>) {
      const stored = await inUnit(() => products.findById(market, productId), true);
      const outcome = await approve.execute(adminContext(), {
        productId,
        revisionId,
        version: stored!.state.version,
        checksConfirmed: ALL_CHECKS,
      });
      expect(outcome).toEqual({ ok: true, value: {} });
    }
    async function submitCopy(productId: Id<'Product'>) {
      return submit.execute(sellerContext(), { productId, replacePending: false });
    }
    async function publishedOnOneAxis() {
      const product = await draftedProduct();
      const productId = product.state.id;
      const first = await submitCopy(productId);
      if (!first.ok) throw new Error(first.error.code);
      await approveRevision(productId, first.value.revisionId);
      return { productId, firstRevisionId: first.value.revisionId };
    }
    const twoAxes = () => ({
      variantAxes: ['size', 'colour'],
      variants: [onSize(VARIANTS[0], 'l', 'r'), onSize(VARIANTS[1], 's', 'b')],
    });

    it('publishes two axes under the same variant ids after a sensitive axis-added revision is approved', async () => {
      const { productId, firstRevisionId } = await publishedOnOneAxis();
      const before = await inUnit(() => revisions.find(market, productId, firstRevisionId), true);
      expect(before!.content.variants.map((variant) => Object.keys(variant.optionValues))).toEqual([
        ['size'],
        ['size'],
      ]);

      await saveCopy(productId, twoAxes(), firstRevisionId);
      const second = await submitCopy(productId);
      if (!second.ok) throw new Error(second.error.code);
      expect(await revisionRow(second.value.revisionId)).toEqual({
        revision_no: 2,
        sensitive: true,
        sensitive_reasons: ['axis-added'],
      });
      expect(await productRow(productId)).toMatchObject({
        published_revision_id: firstRevisionId,
        pending_revision_id: second.value.revisionId,
      });

      await approveRevision(productId, second.value.revisionId);
      expect(await productRow(productId)).toMatchObject({
        status: 'published',
        published_revision_id: second.value.revisionId,
        pending_revision_id: null,
      });
      const after = await inUnit(
        () => revisions.find(market, productId, second.value.revisionId),
        true,
      );
      expect(
        after!.content.variants.map((variant) => [
          variant.variantId,
          variant.optionValues,
          variant.optionKey,
          variant.labels,
        ]),
      ).toEqual([
        [VARIANTS[0], { size: 'l', colour: 'r' }, 'colour=r;size=l', { en: 'l-en · r-en' }],
        [VARIANTS[1], { size: 's', colour: 'b' }, 'colour=b;size=s', { en: 's-en · b-en' }],
      ]);
    });

    it('refuses the second axis when a live variant has no option of it, storing no revision', async () => {
      const { productId, firstRevisionId } = await publishedOnOneAxis();
      await saveCopy(
        productId,
        {
          variantAxes: ['size', 'colour'],
          variants: [onSize(VARIANTS[0], 'l', 'r'), onSize(VARIANTS[1], 's')],
        },
        firstRevisionId,
      );
      const refused = await submitCopy(productId);
      expect(refused).toMatchObject({ ok: false, error: { code: 'revision.not-ready' } });
      if (refused.ok || refused.error.code !== 'revision.not-ready') return;
      expect(refused.error.issues.map((issue) => issue.code)).toContain('variants.option-missing');
      expect(await productRow(productId)).toMatchObject({
        published_revision_id: firstRevisionId,
        pending_revision_id: null,
      });
    });

    it('publishes a second axis at once, not sensitive and with no reason, when the Market does not list axisAdded and approval is off', async () => {
      const { productId, firstRevisionId } = await publishedOnOneAxis();
      axisAdded = false;
      approvalOn = false;
      await saveCopy(productId, twoAxes(), firstRevisionId);
      const second = await submitCopy(productId);
      if (!second.ok) throw new Error(second.error.code);
      expect(second.value).toMatchObject({ revisionNo: 2, published: true });
      expect(await revisionRow(second.value.revisionId)).toEqual({
        revision_no: 2,
        sensitive: false,
        sensitive_reasons: [],
      });
      expect(await productRow(productId)).toMatchObject({
        status: 'published',
        published_revision_id: second.value.revisionId,
        pending_revision_id: null,
      });
      const after = await inUnit(
        () => revisions.find(market, productId, second.value.revisionId),
        true,
      );
      expect(after!.content.variants.map((variant) => variant.variantId)).toEqual([...VARIANTS]);
      expect(after!.content.variants.map((variant) => variant.optionValues)).toEqual([
        { size: 'l', colour: 'r' },
        { size: 's', colour: 'b' },
      ]);
    });

    it('refuses a second axis when the Market allows one axis at most', async () => {
      const { productId, firstRevisionId } = await publishedOnOneAxis();
      maxAxes = 1;
      await saveCopy(productId, twoAxes(), firstRevisionId);
      const refused = await submitCopy(productId);
      expect(refused).toMatchObject({ ok: false, error: { code: 'revision.not-ready' } });
      if (refused.ok || refused.error.code !== 'revision.not-ready') return;
      const codes = refused.error.issues.map((issue) => issue.code);
      expect(codes).toContain('variants.axes-too-many');
      expect(codes).toContain('variants.axes-locked');
      expect(await productRow(productId)).toMatchObject({
        published_revision_id: firstRevisionId,
        pending_revision_id: null,
      });
    });

    it('publishes an admin-authored second axis on a PLATFORM product at once, marked sensitive with axis-added (design 4.2, 4.3)', async () => {
      const product = await draftedProduct('PLATFORM');
      const productId = product.state.id;
      const first = await submit.execute(adminContext(), { productId, replacePending: false });
      if (!first.ok) throw new Error(first.error.code);
      expect(first.value).toMatchObject({ revisionNo: 1, published: true });

      await saveCopy(productId, twoAxes(), first.value.revisionId);
      const second = await submit.execute(adminContext(), { productId, replacePending: false });
      if (!second.ok) throw new Error(second.error.code);
      expect(second.value).toMatchObject({ revisionNo: 2, published: true });
      expect(await revisionRow(second.value.revisionId)).toEqual({
        revision_no: 2,
        sensitive: true,
        sensitive_reasons: ['axis-added'],
      });
      expect(await productRow(productId)).toMatchObject({
        status: 'published',
        published_revision_id: second.value.revisionId,
        pending_revision_id: null,
      });
    });

    it('keeps a product on two axes locked', async () => {
      const { productId, firstRevisionId } = await publishedOnOneAxis();
      await saveCopy(productId, twoAxes(), firstRevisionId);
      const second = await submitCopy(productId);
      if (!second.ok) throw new Error(second.error.code);
      await approveRevision(productId, second.value.revisionId);
      await saveCopy(
        productId,
        { variantAxes: ['size'], variants: [onSize(VARIANTS[0], 'l'), onSize(VARIANTS[1], 's')] },
        second.value.revisionId,
      );
      const refused = await submitCopy(productId);
      expect(refused).toMatchObject({ ok: false, error: { code: 'revision.not-ready' } });
      if (refused.ok || refused.error.code !== 'revision.not-ready') return;
      expect(refused.error.issues.map((issue) => issue.code)).toContain('variants.axes-locked');
    });
  },
);
