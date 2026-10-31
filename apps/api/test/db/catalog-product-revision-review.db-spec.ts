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
import { ProductRevisionApprove } from '../../src/modules/catalog/application/use-cases/product-revision-approve.use-case';
import { ProductRevisionRequestChanges } from '../../src/modules/catalog/application/use-cases/product-revision-request-changes.use-case';
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
        outbox,
        clock: reviewClock,
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
      await saveCopy(created.value.state.id, 'Dates', null);
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

    /** A product with a pending first revision, ready for a decision. */
    async function submitted() {
      const product = await draftedProduct();
      const productId = product.state.id;
      const result = await submit.execute(sellerContext(), { productId, replacePending: false });
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
      expect(appended).toEqual(['catalog.product-revision-changes-requested.v1']);
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
