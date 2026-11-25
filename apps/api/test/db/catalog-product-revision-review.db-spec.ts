import { NO_AUDIT, prismaOfferEditReview } from '../support/catalog-offer-edit-review-fakes';
import { ALL_CATEGORIES_IN_SCOPE } from '../support/seller-scope-allow-all';
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
import { OwnOfferAddTag } from '../../src/modules/catalog/application/use-cases/own-offer-add-tag.use-case';
import { ProductRevisionAdminRead } from '../../src/modules/catalog/application/use-cases/revision-review-read.use-case';
import { ProductRevisionApprove } from '../../src/modules/catalog/application/use-cases/product-revision-approve.use-case';
import { ProductRevisionRequestChanges } from '../../src/modules/catalog/application/use-cases/product-revision-request-changes.use-case';
import { Offer } from '../../src/modules/catalog/domain/offer';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { CertificationClaimTextMatcher } from '../../src/modules/catalog/infrastructure/certification-claim-text-matcher';
import { HmacRateCounterKeys } from '../../src/modules/catalog/infrastructure/hmac-rate-counter-keys';
import { PrismaOwnCatalogReader } from '../../src/modules/catalog/infrastructure/prisma-own-catalog.reader';
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

// Catalog slice 10 (product revision review) on PostgreSQL, for both Market fixtures: the seller's
// submit, then the reviewer's approve and request-changes use cases end to end over the real
// stores (pointer move, variant published, decision rows with their checks, events), the queue
// reads (`listPendingRevisions`, `pendingRevisionCount`) and the seller's view of a change request
// (`latestChangeRequest`).

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
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);

describe.each(TEST_MARKETS)(
  'catalog product revision review in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    let persistence: Persistence;
    let app: Client;
    let products: PrismaProductRepository;
    let copies: PrismaWorkingCopyRepository;
    let revisions: PrismaProductRevisionRepository;
    let reader: PrismaOwnCatalogReader;
    let appended: string[];
    let submit: SubmitProduct;
    let approve: ProductRevisionApprove;
    let requestChanges: ProductRevisionRequestChanges;
    let readRevision: ProductRevisionAdminRead;
    let offerStore: PrismaOfferRepository;
    let evaluator: FakeClaimEvaluator;
    const certificate = {
      certificateId: uuid7() as Id,
      versionId: uuid7() as Id,
      typeRevisionId: uuid7() as Id,
    };
    let categoryId: string;
    let eligible = true;
    const reviewClock = new FixedClock(T1);

    const policy: CatalogMarketPolicy = {
      taxCategoryCodes: () => ['t1'],
      taxCategories: () => ['t1'].map((code) => ({ code, labelKey: `catalog.tax.${code}` })),
      locales: () => ({ default: 'en', supported: ['en'] }),
      sensitiveChanges: () => ({
        platformCategories: true,
        taxCategory: true,
        name: true,
        primaryImage: true,
        anyImage: false,
        variantRemoved: true,
        gtinChanged: true,
        axisAdded: true,
      }),
      maxVariantsPerProduct: () => 10,
      maxVariantAttributes: () => 2,
      units: () => [],
      maxCategoryDepth: () => 4,
      maxCategoryChangeTags: () => 50_000,
      maxCategoryImportRows: () => 2000,
      maxCategoryImportBytes: () => 5 * 1024 * 1024,
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
      reader = new PrismaOwnCatalogReader(persistence.service);
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
        sellerCategories: ALL_CATEGORIES_IN_SCOPE,
        unitOfWork: persistence.unitOfWork,
        products,
        workingCopies: copies,
        revisions,
        freeze: new FreezeRevision({
          revisions,
          familyResolver: fixedFamilyResolver(),
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
      requestChanges = new ProductRevisionRequestChanges(gate, {
        unitOfWork: persistence.unitOfWork,
        products,
        revisions,
        attributes: { familyCodeOfRevision: () => Promise.resolve('default') } as never,
        policy: { defaultFamily: () => 'default' } as never,
        outbox,
        clock: reviewClock,
      });
      readRevision = new ProductRevisionAdminRead(gate, {
        unitOfWork: persistence.unitOfWork,
        products,
        revisions,
        sellerNames: { storeNames: () => Promise.resolve(new Map([[SELLER, 'Dates Co']])) },
        gtinRegistry: { duplicatesOf: () => Promise.resolve([]) },
      });
    });
    beforeEach(() => {
      appended = [];
      eligible = true;
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

    async function saveCopy(productId: Id<'Product'>, name: string, baseRevisionId: string | null) {
      await inUnit(() =>
        copies.save(market, {
          productId,
          content: {
            texts: { en: { name, description: 'Sweet and soft' } },
            categoryIds: [categoryId],
            taxCategoryCode: 't1',
          },
          contentSchemaVersion: 1,
          baseRevisionId: baseRevisionId as Id<'ProductRevision'> | null,
          lastSavedAt: T0,
          lastSavedByAccountId: uuid7() as Id<'Account'>,
        }),
      );
    }

    async function draftedProduct(name = 'Dates', sellerId = SELLER): Promise<Product> {
      const created = Product.create({
        id: uuid7() as Id<'Product'>,
        marketId: market.marketId,
        scope: 'SELLER',
        sellerId,
        handler: simpleProductType,
        familyCode: 'default',
        productCode: `X${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
        variantId: uuid7() as Id<'Variant'>,
        now: T0,
      });
      if (!created.ok) throw new Error(created.error.code);
      await inUnit(() => products.add(market, created.value));
      await saveCopy(created.value.state.id, name, null);
      return created.value;
    }

    const sellerContext = (sellerId = SELLER) =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: uuid7() as Id<'Account'>,
          sessionId: uuid7() as Id<'Session'>,
          sellerId,
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

    /** A product with a pending first revision, ready for a decision. */
    async function submitted(name = 'Dates', sellerId = SELLER) {
      const product = await draftedProduct(name, sellerId);
      const productId = product.state.id;
      const result = await submit.execute(sellerContext(sellerId), {
        productId,
        replacePending: false,
      });
      if (!result.ok) throw new Error(result.error.code);
      const stored = await inUnit(() => products.findById(market, productId), true);
      return {
        productId,
        revisionId: result.value.revisionId,
        version: stored!.state.version,
      };
    }

    async function productRow(productId: string) {
      const { rows } = await app.query(
        `SELECT status, published_revision_id, pending_revision_id, pending_submitted_at, version
           FROM catalog.products WHERE market_id = $1 AND id = $2`,
        [market.marketId, productId],
      );
      return rows[0] as {
        status: string;
        published_revision_id: string | null;
        pending_revision_id: string | null;
        pending_submitted_at: Date | null;
        version: number;
      };
    }
    async function decisionRows(productId: string) {
      const { rows } = await app.query(
        `SELECT d.revision_id, d.outcome, d.publish_kind, d.reason_code, d.required_checks,
                d.confirmed_checks, d.decided_by_kind, d.decided_by_account_id, d.product_version
           FROM catalog.product_revision_decisions d
           JOIN catalog.product_revisions r ON r.market_id = d.market_id AND r.id = d.revision_id
          WHERE r.market_id = $1 AND r.product_id = $2 ORDER BY r.revision_no`,
        [market.marketId, productId],
      );
      return rows as {
        revision_id: string;
        outcome: string;
        publish_kind: string | null;
        reason_code: string | null;
        required_checks: string[];
        confirmed_checks: string[];
        decided_by_kind: string;
        decided_by_account_id: string | null;
        product_version: number;
      }[];
    }
    async function variantStates(productId: string) {
      const { rows } = await app.query(
        `SELECT state FROM catalog.product_variants WHERE market_id = $1 AND product_id = $2`,
        [market.marketId, productId],
      );
      return rows.map((row: { state: string }) => row.state);
    }

    it('lists the pending revision in the queue with its classification, then approves it', async () => {
      const { productId, revisionId, version } = await submitted();

      const queue = await inUnit(
        () => reader.listPendingRevisions(market, { after: null, limit: 500 }, 'en'),
        true,
      );
      const mine = queue.find((row) => row.productId === productId);
      expect(mine).toMatchObject({
        productVersion: version,
        sellerId: SELLER,
        revisionId,
        revisionNo: 1,
        firstPublication: true,
        hasImages: false,
        name: 'Dates',
      });
      expect(mine!.sensitiveReasons).toEqual(expect.arrayContaining(['never-published']));
      expect(await inUnit(() => reader.pendingRevisionCount(market), true)).toBeGreaterThanOrEqual(
        1,
      );

      appended = [];
      const outcome = await approve.execute(adminContext(), {
        productId,
        revisionId,
        version,
        checksConfirmed: ALL_CHECKS,
      });

      expect(outcome).toEqual({ ok: true, value: {} });
      expect(await productRow(productId)).toMatchObject({
        status: 'published',
        published_revision_id: revisionId,
        pending_revision_id: null,
        pending_submitted_at: null,
      });
      expect(await variantStates(productId)).toEqual(['published']);
      expect(await decisionRows(productId)).toEqual([
        {
          revision_id: revisionId,
          outcome: 'published',
          publish_kind: 'reviewed',
          reason_code: null,
          required_checks: ALL_CHECKS,
          confirmed_checks: ALL_CHECKS,
          decided_by_kind: 'admin',
          decided_by_account_id: ADMIN,
          product_version: version,
        },
      ]);
      expect(appended).toEqual(['catalog.product-revision-published.v1']);
      const after = await inUnit(
        () => reader.listPendingRevisions(market, { after: null, limit: 500 }, 'en'),
        true,
      );
      expect(after.some((row) => row.productId === productId)).toBe(false);
    });

    it('refuses a second decision on the same revision and a stale version, storing nothing more', async () => {
      const { productId, revisionId, version } = await submitted();

      expect(
        await approve.execute(adminContext(), {
          productId,
          revisionId,
          version: version + 1,
          checksConfirmed: ALL_CHECKS,
        }),
      ).toEqual({ ok: false, error: { code: 'conflict.stale' } });
      expect(await decisionRows(productId)).toHaveLength(0);

      const first = await approve.execute(adminContext(), {
        productId,
        revisionId,
        version,
        checksConfirmed: ALL_CHECKS,
      });
      expect(first.ok).toBe(true);
      const again = await approve.execute(adminContext(), {
        productId,
        revisionId,
        version,
        checksConfirmed: ALL_CHECKS,
      });
      expect(again.ok).toBe(false);
      expect(await decisionRows(productId)).toHaveLength(1);
    });

    it('refuses an approval with a missing check or an ineligible seller, storing nothing', async () => {
      const { productId, revisionId, version } = await submitted();

      const missing = await approve.execute(adminContext(), {
        productId,
        revisionId,
        version,
        checksConfirmed: ['category-fits'],
      });
      expect(missing).toMatchObject({ ok: false, error: { code: 'review.checks-missing' } });
      eligible = false;
      expect(
        await approve.execute(adminContext(), {
          productId,
          revisionId,
          version,
          checksConfirmed: ALL_CHECKS,
        }),
      ).toEqual({ ok: false, error: { code: 'seller.not-eligible' } });

      expect(await productRow(productId)).toMatchObject({
        status: 'unpublished',
        pending_revision_id: revisionId,
        published_revision_id: null,
      });
      expect(await decisionRows(productId)).toHaveLength(0);
    });

    it('sends the revision back: pending cleared, the reason on the decision, visible to the seller until a resubmit', async () => {
      const { productId, revisionId, version } = await submitted();
      appended = [];

      const outcome = await requestChanges.execute(adminContext(), {
        productId,
        revisionId,
        version,
        reasonCode: 'description-claim',
      });

      expect(outcome).toEqual({ ok: true, value: {} });
      expect(await productRow(productId)).toMatchObject({
        status: 'unpublished',
        published_revision_id: null,
        pending_revision_id: null,
        pending_submitted_at: null,
      });
      const [decision] = await decisionRows(productId);
      expect(decision).toMatchObject({
        revision_id: revisionId,
        outcome: 'changes-requested',
        publish_kind: null,
        reason_code: 'description-claim',
        confirmed_checks: [],
        decided_by_kind: 'admin',
        decided_by_account_id: ADMIN,
      });
      expect(appended).toEqual(['catalog.product-revision-changes-requested.v2']);
      const view = await inUnit(() => revisions.latestChangeRequest(market, productId), true);
      expect(view).toMatchObject({
        revisionId,
        revisionNo: 1,
        reasonCode: 'description-claim',
      });
      expect(view!.decidedAt.toString()).toBe(T1.toString());

      // The seller edits and submits again: the newest revision has no request.
      await saveCopy(productId, 'Dates, new box', null);
      const again = await submit.execute(sellerContext(), { productId, replacePending: false });
      expect(again.ok).toBe(true);
      expect(await inUnit(() => revisions.latestChangeRequest(market, productId), true)).toBeNull();
      const stillThere = await decisionRows(productId);
      expect(stillThere).toHaveLength(1);
    });

    it('keeps the queue rows the filters ask for, in the list and in the count', async () => {
      const { productId } = await submitted();
      const OTHER = uuid7() as Id<'Seller'>;
      const page = { after: null, limit: 500 };
      const has = async (filter: Parameters<typeof reader.listPendingRevisions>[3]) => {
        const rows = await inUnit(
          () => reader.listPendingRevisions(market, page, 'en', filter),
          true,
        );
        const count = await inUnit(() => reader.pendingRevisionCount(market, filter), true);
        expect(count).toBeGreaterThanOrEqual(rows.length);
        return rows.some((row) => row.productId === productId);
      };

      expect(await has({ sellerId: SELLER })).toBe(true);
      expect(await has({ sellerId: OTHER })).toBe(false);
      expect(
        await inUnit(() => reader.pendingRevisionCount(market, { sellerId: OTHER }), true),
      ).toBe(0);
      expect(await has({ firstPublication: true })).toBe(true);
      expect(await has({ firstPublication: false })).toBe(false);
      expect(await has({ hasImages: false })).toBe(true);
      expect(await has({ hasImages: true })).toBe(false);
      expect(await has({ sellerId: SELLER, firstPublication: true, hasImages: false })).toBe(true);
      expect(await inUnit(() => reader.pendingReviewCount(market, { sellerId: OTHER }), true)).toBe(
        0,
      );
      expect(
        await inUnit(() => offerStore.listPendingReview(market, page, { sellerId: OTHER }), true),
      ).toEqual([]);
    });

    // The search tests use a token of their own in the name and a seller of their own, so rows that
    // other specs write to the same database at the same time cannot match.
    const token = () => `Qz${uuid7().replaceAll('-', '').slice(-10)}`;
    const searchOf = (text: string, sellerIds: Id<'Seller'>[] = [], locale = 'en') => ({
      search: { text, locale, sellerIds },
    });
    const productCodeOf = async (productId: string) => {
      const { rows } = await app.query(
        `SELECT product_code FROM catalog.products WHERE market_id = $1 AND id = $2`,
        [market.marketId, productId],
      );
      return (rows[0] as { product_code: string }).product_code;
    };
    const otherMarket = marketOf(code === 'AU' ? 'ZZ' : 'AU');
    const inOtherUnit = <T>(work: () => Promise<T>): Promise<T> =>
      persistence.unitOfWork
        .run(otherMarket, async () => ({ ok: true as const, value: await work() }), {
          readOnly: true,
        })
        .then((result) => {
          if (!result.ok) throw new Error('unit failed');
          return result.value;
        });

    it('keeps the queue rows the search text matches: code, pending name or store, as typed', async () => {
      const name = `Dates ${token()}`;
      const seller = uuid7() as Id<'Seller'>;
      const { productId } = await submitted(name, seller);
      const productCode = await productCodeOf(productId);
      const OTHER = uuid7() as Id<'Seller'>;
      const page = { after: null, limit: 500 };
      const found = async (filter: Parameters<typeof reader.listPendingRevisions>[3]) => {
        const rows = await inUnit(
          () => reader.listPendingRevisions(market, page, 'en', filter),
          true,
        );
        const count = await inUnit(() => reader.pendingRevisionCount(market, filter), true);
        expect(count).toBe(rows.length);
        return rows.map((row) => row.productId);
      };
      const tokenText = name.slice(6);

      // The product code, in any case and in part.
      expect(await found(searchOf(productCode.slice(2, 13).toLowerCase()))).toEqual([productId]);
      // The pending revision's name in the locale, in any case.
      expect(await found(searchOf(tokenText.toUpperCase()))).toEqual([productId]);
      expect(await found(searchOf(tokenText, [], 'xx'))).toEqual([]);
      // Wildcards are matched as typed: `%` and `_` are not "any".
      expect(await found(searchOf(`${tokenText.slice(0, 3)}%`))).toEqual([]);
      expect(await found(searchOf(`${tokenText.slice(0, 2)}_${tokenText.slice(3)}`))).toEqual([]);
      expect(await found(searchOf(`${tokenText}\\`))).toEqual([]);
      // A store match keeps the seller's rows whatever their text.
      expect(await found(searchOf('no such text here', [seller]))).toEqual([productId]);
      expect(await found(searchOf('no such text here', [OTHER]))).toEqual([]);
      // It composes with the other filters.
      expect(await found({ ...searchOf(tokenText), sellerId: OTHER })).toEqual([]);
      expect(
        await found({ ...searchOf(tokenText), sellerId: seller, firstPublication: true }),
      ).toEqual([productId]);
      expect(await found({ ...searchOf(tokenText), firstPublication: false })).toEqual([]);
      // The other Market never answers this Market's row, though the text and the store match.
      const filter = searchOf(tokenText, [seller]);
      expect(
        await inOtherUnit(() => reader.listPendingRevisions(otherMarket, page, 'en', filter)),
      ).toEqual([]);
      expect(await inOtherUnit(() => reader.pendingRevisionCount(otherMarket, filter))).toBe(0);
    });

    it('pages through the search by keyset: page 2 holds only matching rows, none twice', async () => {
      const text = token();
      const first = await submitted(`Dates ${text} one`);
      await submitted(`Dates ${token()} not this one`);
      const second = await submitted(`Dates ${text} two`);
      const third = await submitted(`Dates ${text} three`);
      const filter = searchOf(text);
      const read = (after: { submittedAt: Temporal.Instant; id: string } | null) =>
        inUnit(() => reader.listPendingRevisions(market, { after, limit: 1 }, 'en', filter), true);

      const seen: string[] = [];
      let after: { submittedAt: Temporal.Instant; id: string } | null = null;
      for (let pageNo = 0; pageNo < 4; pageNo += 1) {
        const rows = await read(after);
        if (rows.length === 0) break;
        expect(rows).toHaveLength(1);
        seen.push(rows[0]!.productId);
        after = { submittedAt: rows[0]!.submittedAt, id: rows[0]!.productId };
      }
      expect(seen).toEqual([first.productId, second.productId, third.productId]);
      expect(await inUnit(() => reader.pendingRevisionCount(market, filter), true)).toBe(3);
    });

    it('keeps a waiting Offer by the published name of its product, in this Market only', async () => {
      const name = `Dates ${token()}`;
      const seller = uuid7() as Id<'Seller'>;
      const { productId, revisionId, version } = await submitted(name, seller);
      const approved = await approve.execute(adminContext(), {
        productId,
        revisionId,
        version,
        checksConfirmed: ALL_CHECKS,
      });
      expect(approved).toEqual({ ok: true, value: {} });
      const created = Offer.create({
        id: uuid7() as Id<'Offer'>,
        marketId: market.marketId,
        sellerId: seller,
        productId,
        sellerSku: `Q-${uuid7().slice(-12)}`,
        conditionCode: 'new',
        description: { en: 'Soft dates' },
        now: T0,
      });
      if (!created.ok) throw new Error(created.error.code);
      const offer = created.value;
      const sellerActor = { kind: 'seller' as const, accountId: uuid7() as Id<'Account'> };
      await inUnit(() => offerStore.add(market, offer, sellerActor));
      const load = async () => {
        const found = await inUnit(() => offerStore.findById(market, offer.state.id), true);
        if (found === null) throw new Error('setup');
        return found;
      };
      const handled = await load();
      expect(handled.setHandling({ handling: 'SEALED_ORIGINAL', now: T0 }).ok).toBe(true);
      await inUnit(() => offerStore.save(market, handled, sellerActor));
      const waiting = await load();
      expect(waiting.submit({ approvalRequired: true, now: T1 }).ok).toBe(true);
      await inUnit(() => offerStore.save(market, waiting, sellerActor));

      const page = { after: null, limit: 500 };
      const offersFor = async (filter: Parameters<typeof offerStore.listPendingReview>[2]) => {
        const rows = await inUnit(() => offerStore.listPendingReview(market, page, filter), true);
        const count = await inUnit(() => reader.pendingReviewCount(market, filter), true);
        expect(count).toBe(rows.length);
        return rows.map((row) => row.state.id);
      };
      const tokenText = name.slice(6);
      expect(await offersFor(searchOf(tokenText.toLowerCase()))).toEqual([offer.state.id]);
      expect(await offersFor(searchOf(tokenText, [], 'xx'))).toEqual([]);
      expect(await offersFor(searchOf(`${tokenText.slice(0, 2)}_${tokenText.slice(3)}`))).toEqual(
        [],
      );
      // The other Market never answers this Market's Offer, though the text and the store match.
      const filter = searchOf(tokenText, [seller]);
      expect(
        await inOtherUnit(() => offerStore.listPendingReview(otherMarket, page, filter)),
      ).toEqual([]);
      expect(await inOtherUnit(() => reader.pendingReviewCount(otherMarket, filter))).toBe(0);
    });

    it('keeps the queue rows submitted in the range: submittedFrom inclusive, submittedTo exclusive', async () => {
      const { productId } = await submitted();
      const page = { after: null, limit: 500 };
      const rows = await inUnit(() => reader.listPendingRevisions(market, page, 'en'), true);
      const mine = rows.find((row) => row.productId === productId);
      if (mine === undefined) throw new Error('setup');
      const at = mine.submittedAt;
      const has = async (filter: Parameters<typeof reader.listPendingRevisions>[3]) => {
        const found = await inUnit(
          () => reader.listPendingRevisions(market, page, 'en', filter),
          true,
        );
        const count = await inUnit(() => reader.pendingRevisionCount(market, filter), true);
        expect(count).toBe(found.length);
        return found.some((row) => row.productId === productId);
      };
      expect(await has({ submittedFrom: at })).toBe(true);
      expect(await has({ submittedTo: at })).toBe(false);
      expect(await has({ submittedFrom: at, submittedTo: at.add({ milliseconds: 1 }) })).toBe(true);
      expect(await has({ submittedFrom: at.add({ milliseconds: 1 }) })).toBe(false);
      expect(await has({ submittedTo: at.add({ hours: 1 }), sellerId: SELLER })).toBe(true);
      // The same window on the Offers waiting for their first publication.
      const future = at.add({ hours: 24 * 365 });
      expect(
        await inUnit(() => reader.pendingReviewCount(market, { submittedFrom: future }), true),
      ).toBe(0);
      expect(
        await inUnit(
          () => offerStore.listPendingReview(market, page, { submittedFrom: future }),
          true,
        ),
      ).toEqual([]);
      expect(
        await inUnit(() => reader.pendingReviewCount(market, { submittedTo: future }), true),
      ).toBe(await inUnit(() => reader.pendingReviewCount(market), true));
    });

    it('reads a revision for review with its history: decided ones carry the outcome and code', async () => {
      const { productId, revisionId, version } = await submitted();
      await requestChanges.execute(adminContext(), {
        productId,
        revisionId,
        version,
        reasonCode: 'photos',
      });
      await saveCopy(productId, 'Dates, new box', null);
      const again = await submit.execute(sellerContext(), { productId, replacePending: false });
      if (!again.ok) throw new Error(again.error.code);

      const read = await readRevision.execute(adminContext(), {
        productId,
        revisionId: again.value.revisionId,
      });

      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value).toMatchObject({
        productId,
        sellerId: SELLER,
        storeName: 'Dates Co',
        state: 'pending',
        firstPublication: true,
        requiredChecks: ALL_CHECKS,
        published: null,
        revision: {
          revisionId: again.value.revisionId,
          revisionNo: 2,
          texts: { en: { name: 'Dates, new box', description: 'Sweet and soft' } },
          categoryIds: [categoryId],
          taxCategoryCode: 't1',
        },
      });
      expect(read.value.history).toEqual([
        expect.objectContaining({ revisionNo: 2, decision: null }),
        expect.objectContaining({ revisionId, revisionNo: 1, authorKind: 'seller' }),
      ]);
      expect(read.value.history[1]!.decision).toEqual({
        outcome: 'changes-requested',
        publishKind: null,
        supersededCause: null,
        reasonCode: 'photos',
        decidedByKind: 'admin',
        decidedAt: T1.toString(),
      });
      const closed = await readRevision.execute(adminContext(), { productId, revisionId });
      expect(closed).toMatchObject({ ok: true, value: { state: 'closed', requiredChecks: [] } });
      expect(
        await readRevision.execute(adminContext(), {
          productId: uuid7(),
          revisionId,
        }),
      ).toEqual({ ok: false, error: { code: 'product.not-found' } });
    });

    it('filters an update with a photo against PostgreSQL: firstPublication false, hasImages true', async () => {
      const first = await submitted();
      await approve.execute(adminContext(), { ...first, checksConfirmed: ALL_CHECKS });
      const { productId } = first;
      await saveCopy(productId, 'Dates, new box', first.revisionId);
      const again = await submit.execute(sellerContext(), { productId, replacePending: false });
      if (!again.ok) throw new Error(again.error.code);
      const imageId = uuid7();
      await insert('product_images', {
        ...base,
        id: imageId,
        product_id: productId,
        uploader_account_id: uuid7(),
        state: 'clean',
        pixel_width: 800,
        pixel_height: 800,
        byte_size: 1000,
        created_at: T0.toString(),
      });
      await insert('product_revision_images', {
        ...base,
        revision_id: again.value.revisionId,
        product_id: productId,
        image_id: imageId,
        position: 1,
      });
      const page = { after: null, limit: 500 };
      const has = async (filter: Parameters<typeof reader.listPendingRevisions>[3]) =>
        (await inUnit(() => reader.listPendingRevisions(market, page, 'en', filter), true)).some(
          (row) => row.productId === productId,
        );

      expect(await has({ firstPublication: false })).toBe(true);
      expect(await has({ firstPublication: true })).toBe(false);
      expect(await has({ hasImages: true })).toBe(true);
      expect(await has({ hasImages: false })).toBe(false);
      expect(await has({ sellerId: SELLER, firstPublication: false, hasImages: true })).toBe(true);
      expect(
        await inUnit(
          () => reader.pendingRevisionCount(market, { firstPublication: false, hasImages: true }),
          true,
        ),
      ).toBeGreaterThanOrEqual(1);

      const read = await readRevision.execute(adminContext(), {
        productId,
        revisionId: again.value.revisionId,
      });
      expect(read).toMatchObject({
        ok: true,
        value: {
          state: 'pending',
          firstPublication: false,
          revision: { revisionNo: 2, imageIds: [imageId] },
          published: { revisionId: first.revisionId, revisionNo: 1, imageIds: [] },
        },
      });
    });

    it("never returns the reviewer's words or account ids, and not another Market's product", async () => {
      const { productId, revisionId } = await submitted();
      const DECIDER = uuid7();
      await insert('product_revision_decisions', {
        ...base,
        revision_id: revisionId,
        outcome: 'changes-requested',
        reason_code: 'other',
        reason_text: 'secret reviewer words',
        required_checks: [],
        confirmed_checks: [],
        decided_by_kind: 'admin',
        decided_by_account_id: DECIDER,
        product_version: 1,
        decided_at: T1.toString(),
      });

      const read = await readRevision.execute(adminContext(), { productId, revisionId });

      expect(read.ok).toBe(true);
      const text = JSON.stringify(read);
      expect(text).toContain('"reasonCode":"other"');
      expect(text).not.toContain('secret reviewer words');
      expect(text).not.toContain(DECIDER);
      const revision = await inUnit(() => revisions.find(market, productId, revisionId), true);
      expect(text).not.toContain(revision!.authorAccountId);

      const other = marketOf(TEST_MARKETS.find((m) => m !== code)!);
      const otherAdmin = testCallContext(
        other,
        testAuthenticatedActor(other, {
          population: 'admin',
          accountId: ADMIN,
          sessionId: uuid7() as Id<'Session'>,
          sellerId: null,
        }),
      );
      expect(await readRevision.execute(otherAdmin, { productId, revisionId })).toEqual({
        ok: false,
        error: { code: 'product.not-found' },
      });
      const elsewhere = await persistence.unitOfWork.run(
        other,
        async () =>
          ok(
            await reader.listPendingRevisions(other, { after: null, limit: 500 }, 'en', {
              sellerId: SELLER,
            }),
          ),
        { readOnly: true },
      );
      expect(elsewhere.ok && elsewhere.value.some((row) => row.productId === productId)).toBe(
        false,
      );
    });

    it('publishes a later revision over the first one, with no check for a name-only change', async () => {
      const { productId, revisionId, version } = await submitted();
      await approve.execute(adminContext(), {
        productId,
        revisionId,
        version,
        checksConfirmed: ALL_CHECKS,
      });
      await saveCopy(productId, 'Medjool dates', revisionId);
      const second = await submit.execute(sellerContext(), { productId, replacePending: false });
      if (!second.ok) throw new Error(second.error.code);
      const stored = await inUnit(() => products.findById(market, productId), true);
      const queue = await inUnit(
        () => reader.listPendingRevisions(market, { after: null, limit: 500 }, 'en'),
        true,
      );
      expect(queue.find((row) => row.productId === productId)).toMatchObject({
        revisionNo: 2,
        firstPublication: false,
        name: 'Medjool dates',
      });

      const outcome = await approve.execute(adminContext(), {
        productId,
        revisionId: second.value.revisionId,
        version: stored!.state.version,
        checksConfirmed: [],
      });

      expect(outcome).toEqual({ ok: true, value: {} });
      expect(await productRow(productId)).toMatchObject({
        status: 'published',
        published_revision_id: second.value.revisionId,
        pending_revision_id: null,
      });
      expect(await variantStates(productId)).toEqual(['published']);
      const decisions = await decisionRows(productId);
      expect(decisions.map((d) => d.outcome)).toEqual(['published', 'published']);
      expect(decisions[1]!.required_checks).toEqual([]);
    });

    it('re-asks a tag written while the approval waits on the product row against the new revision (Hassan M-1)', async () => {
      // Revision 1 published, the owner's Offer on it, revision 2 pending.
      const { productId, revisionId: first, version } = await submitted();
      expect(
        await approve.execute(adminContext(), {
          productId,
          revisionId: first,
          version,
          checksConfirmed: ALL_CHECKS,
        }),
      ).toMatchObject({ ok: true });
      const offerId = uuid7() as Id<'Offer'>;
      await insert('offers', {
        id: offerId,
        ...base,
        seller_id: SELLER,
        product_id: productId,
        seller_sku: `SKU-${randomUUID().slice(0, 13)}`,
        condition_code: 'new',
        description: '{}',
        handling: 'SEALED_ORIGINAL',
        attestation_recorded_at: null,
        attestation_account_id: null,
        status: 'published',
        off_sale_type_not_allowed: false,
        off_sale_product_retired: false,
        off_sale_product_not_listed: false,
        off_sale_tag_suspended: false,
        off_sale_product_paused: false,
        off_sale_description_claim_text: false,
        listed: true,
        submitted_at: T0.toString(),
        first_published_at: T0.toString(),
        deleted_at: null,
        version: 1,
        created_at: T0.toString(),
      });
      await saveCopy(productId, 'Medjool dates', first);
      const second = await submit.execute(sellerContext(), { productId, replacePending: false });
      if (!second.ok) throw new Error(second.error.code);
      const pending = await inUnit(() => products.findById(market, productId), true);

      // The seller adds a tag judged on revision 1. Its unit holds the product lock and the
      // uncommitted tag while the REAL approval of revision 2 starts, then commits ~300 ms later.
      const typeCode = code === 'AU' ? 'halal' : 'zz-cert';
      const tagEvaluator = new FakeClaimEvaluator(
        (query) => allowedDecision(query, certificate),
        [typeCode],
      );
      const approvalCalls = evaluator.calls.length;
      // The tag unit signals that it holds the lock, then waits for the test to release it; the
      // approval starts from the test body, outside the tag unit's async context.
      let held!: () => void;
      const holding = new Promise<void>((resolve) => (held = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const addTag = new OwnOfferAddTag(gate, {
        editReview: prismaOfferEditReview(
          persistence.service,
          { next: () => uuid7() } as never,
          NO_AUDIT,
        ),
        unitOfWork: persistence.unitOfWork,
        offers: offerStore,
        eligibility: { isEligible: () => Promise.resolve(true) },
        save: { reserveSaves: () => Promise.resolve(null) },
        claims: new ClaimQueryBuilder({
          products,
          revisions,
          categoryPaths: new PrismaCategoryPathsReader(persistence.service),
        }),
        evaluator: tagEvaluator,
        outbox: {
          append: async () => {
            held();
            await released;
          },
        },
        clock: reviewClock,
        ids: { next: <K extends string>() => uuid7() as Id<K> },
      });

      const adding = addTag.execute(sellerContext(), { offerId, typeCode });
      await holding;
      const approval = approve
        .execute(adminContext(), {
          productId,
          revisionId: second.value.revisionId,
          version: pending!.state.version,
          checksConfirmed: ALL_CHECKS,
        })
        .then((outcome) => ({ outcome, doneAt: Date.now() }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      const committedAt = Date.now();
      release();

      const added = await adding;
      expect(added).toMatchObject({ ok: true, value: { status: 'active' } });
      expect(tagEvaluator.calls.map((call) => call[0]!.productRevisionId)).toEqual([first]);
      const { outcome, doneAt } = await approval;
      expect(outcome).toEqual({ ok: true, value: {} });
      // The approval waited for the tag's unit, then asked the new tag against revision 2.
      expect(doneAt).toBeGreaterThanOrEqual(committedAt);
      const asked = evaluator.calls.slice(approvalCalls).flat();
      expect(asked.map((query) => [query.typeCode, query.productRevisionId])).toContainEqual([
        typeCode,
        second.value.revisionId,
      ]);
      expect(await productRow(productId)).toMatchObject({
        published_revision_id: second.value.revisionId,
      });
      const { rows } = await app.query(
        `SELECT status, copy_revision_id, badge_data IS NOT NULL AS has_badge
           FROM catalog.offer_tags WHERE market_id = $1 AND offer_id = $2`,
        [market.marketId, offerId],
      );
      expect(rows).toEqual([
        { status: 'active', copy_revision_id: second.value.revisionId, has_badge: true },
      ]);
    });

    it('pages the pending revisions by submit instant and id', async () => {
      const a = await submitted();
      const b = await submitted();
      const mine = new Set<string>([a.productId, b.productId]);
      const page = (after: { submittedAt: Temporal.Instant; id: string } | null) =>
        inUnit(() => reader.listPendingRevisions(market, { after, limit: 500 }, 'en'), true);

      const all = (await page(null)).filter((row) => mine.has(row.productId));
      expect(all).toHaveLength(2);
      const [first, second] = all as [(typeof all)[number], (typeof all)[number]];
      const rest = (await page({ submittedAt: first.submittedAt, id: first.productId })).filter(
        (row) => mine.has(row.productId),
      );
      expect(rest.map((row) => row.productId)).toEqual([second.productId]);
    });
  },
);
