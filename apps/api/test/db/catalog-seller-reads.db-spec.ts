import { randomUUID } from 'node:crypto';
import { Temporal, ok, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import type { MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { OwnOfferRead } from '../../src/modules/catalog/application/use-cases/own-offer-read.use-case';
import { OwnOffersList } from '../../src/modules/catalog/application/use-cases/own-offers-list.use-case';
import { OwnProductRead } from '../../src/modules/catalog/application/use-cases/own-product-read.use-case';
import { PlatformProductRead } from '../../src/modules/catalog/application/use-cases/platform-product-read.use-case';
import {
  OwnProductsExport,
  type OwnProductsExportInput,
} from '../../src/modules/catalog/application/use-cases/own-products-export.use-case';
import { OwnProductsList } from '../../src/modules/catalog/application/use-cases/own-products-list.use-case';
import { Offer } from '../../src/modules/catalog/domain/offer';
import { ExceljsSheetWriter } from '../../src/modules/catalog/infrastructure/xlsx/exceljs-sheet-writer';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaOwnCatalogReader } from '../../src/modules/catalog/infrastructure/prisma-own-catalog.reader';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../support/test-config';
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
import { PrismaTagReevaluationRequests } from '../../src/modules/catalog/infrastructure/prisma-tag-reevaluation-requests';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';
import { fixedFamilyResolver } from '../support/family-resolver';

// Catalog slice 7 reads (own-products.list, own-product.read, own-offers.list, own-offer.read) on PostgreSQL, for both Market fixtures: the submit
// service end to end over the real stores (freeze, claim check, revision rows, product pointer,
// events) and the loss of a race on the revision number mapped to a stale conflict.

const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');
const clock = new FixedClock(T0);
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
let sequence = 0;
// Own ids: catalog-own-product-submit.db-spec.ts submits products for the b001 seller in a parallel worker
// of the same database, and this file lists every product of its seller.
const SELLER = '01990000-0000-7000-8000-00000000c5a1' as Id<'Seller'>;
const OTHER = '01990000-0000-7000-8000-00000000c5a2' as Id<'Seller'>;
// The list-mode test owns this seller, so the rows it counts are its own alone.
const LISTED = '01990000-0000-7000-8000-00000000c5a3' as Id<'Seller'>;
// The export test owns this seller too.
const EXPORTED = '01990000-0000-7000-8000-00000000c5a7' as Id<'Seller'>;
// Own sellers for the filter alignment, the name-sort ceiling and the name order tests.
const ALIGNED = '01990000-0000-7000-8000-00000000c5a4' as Id<'Seller'>;
const CEILING = '01990000-0000-7000-8000-00000000c5a5' as Id<'Seller'>;
const ORDERED = '01990000-0000-7000-8000-00000000c5a6' as Id<'Seller'>;
// The snapshot test of the export edits this seller's products while a file streams.
const STREAMED = '01990000-0000-7000-8000-00000000c5a8' as Id<'Seller'>;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('catalog seller reads in market %s (database integration)', (code) => {
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
        revisions,
        familyResolver: fixedFamilyResolver(),
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
      offers: new PrismaOfferRepository(persistence.service, {
        next: <K extends string>() => uuid7() as Id<K>,
      }),
      requests: new PrismaTagReevaluationRequests(persistence.service),
    });
  });
  beforeEach(() => {
    appended = [];
  });
  afterAll(async () => {
    await app.end();
    await persistence.close();
  });

  const inUnitOf = <T>(where: MarketContext, work: () => Promise<T>): Promise<T> =>
    persistence.unitOfWork
      .run(where, async () => ({ ok: true as const, value: await work() }))
      .then((result) => {
        if (!result.ok) throw new Error('unit failed');
        return result.value;
      });
  const inUnit = <T>(work: () => Promise<T>): Promise<T> => inUnitOf(market, work);

  async function draftedProduct(
    scope: 'SELLER' | 'PLATFORM' = 'SELLER',
    owner: Id<'Seller'> = SELLER,
    name = 'Dates',
  ): Promise<Product> {
    const created = Product.create({
      id: uuid7() as Id<'Product'>,
      marketId: market.marketId,
      scope,
      sellerId: scope === 'SELLER' ? owner : null,
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
          texts: { en: { name, description: 'Sweet and soft' } },
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

  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  let reader: PrismaOwnCatalogReader;
  let offers: PrismaOfferRepository;
  let list: OwnProductsList;
  let exporter: OwnProductsExport;
  let read: OwnProductRead;
  let readPlatform: PlatformProductRead;
  let listOffers: OwnOffersList;
  let readOffer: OwnOfferRead;
  beforeAll(() => {
    reader = new PrismaOwnCatalogReader(persistence.service);
    offers = new PrismaOfferRepository(persistence.service, {
      next: <K extends string>() => uuid7() as Id<K>,
    });
    list = new OwnProductsList(gate, {
      unitOfWork: persistence.unitOfWork,
      ownReader: reader,
      policy,
    });
    exporter = new OwnProductsExport(gate, {
      unitOfWork: persistence.unitOfWork,
      ownReader: reader,
      policy,
      sheetWriter: new ExceljsSheetWriter(),
      clock,
    });
    read = new OwnProductRead(gate, {
      unitOfWork: persistence.unitOfWork,
      products,
      workingCopies: copies,
      revisions,
      ownReader: reader,
      policy,
    });
    readPlatform = new PlatformProductRead(gate, {
      unitOfWork: persistence.unitOfWork,
      products,
      workingCopies: copies,
      revisions,
      ownReader: reader,
      policy,
    });
    listOffers = new OwnOffersList(gate, {
      unitOfWork: persistence.unitOfWork,
      ownReader: reader,
      policy,
    });
    readOffer = new OwnOfferRead(gate, {
      unitOfWork: persistence.unitOfWork,
      offers,
      ownReader: reader,
      policy,
    });
  });

  async function offerOn(productId: Id<'Product'>, seller: Id<'Seller'>, sku: string) {
    const created = Offer.create({
      id: uuid7() as Id<'Offer'>,
      marketId: market.marketId,
      sellerId: seller,
      productId,
      sellerSku: sku,
      conditionCode: 'new',
      description: { en: 'mine' },
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    const refusal = await inUnit(() =>
      offers.add(market, created.value, { kind: 'seller', accountId: uuid7() as Id<'Account'> }),
    );
    if (refusal !== null) throw new Error(refusal);
    return created.value;
  }

  it('lists only the seller’s own products, newest first, in pages, with the draft name', async () => {
    const mine = [
      await draftedProduct('SELLER', SELLER, 'First'),
      await draftedProduct('SELLER', SELLER, 'Second'),
      await draftedProduct('SELLER', SELLER, 'Third'),
    ];
    await draftedProduct('SELLER', OTHER, 'Not mine');
    await draftedProduct('PLATFORM', SELLER, 'Platform');
    const ctx = sellerContext(uuid7() as Id<'Seller'>);
    const empty = await list.execute(ctx, {});
    expect(empty.ok && empty.value.items).toEqual([]);

    const first = await list.execute(sellerContext(), { limit: 2 });
    if (!first.ok) throw new Error(first.error.code);
    if (!('nextAfterId' in first.value)) throw new Error('not the keyset answer');
    const ids = (value: typeof first.value) => value.items.map((item) => item.productId);
    // Rows of earlier tests of this file are the same seller's, so compare the newest ones.
    expect(ids(first.value)).toEqual([mine[2]!.state.id, mine[1]!.state.id]);
    expect(first.value.items.map((item) => item.draftName)).toEqual(['Third', 'Second']);
    expect(first.value.nextAfterId).toBe(mine[1]!.state.id);
    const second = await list.execute(sellerContext(), {
      limit: 2,
      afterId: first.value.nextAfterId,
    });
    if (!second.ok) throw new Error(second.error.code);
    expect(second.value.items[0]!.productId).toBe(mine[0]!.state.id);
    const everything = await list.execute(sellerContext(), { limit: 50 });
    if (!everything.ok) throw new Error(everything.error.code);
    for (const item of everything.value.items) {
      expect(item.status).toBe('draft');
      expect(item.hasPublishedRevision).toBe(false);
      expect(item.productCode).toMatch(/^X/);
    }
    const other = await list.execute(sellerContext(OTHER), { limit: 50 });
    expect(other.ok && other.value.items.map((item) => item.draftName)).toContain('Not mine');
    expect(other.ok && other.value.items.map((item) => item.draftName)).not.toContain('Third');
  });

  it('lists with views, counts, search, filters, sort and page numbers over the seller’s own products only', async () => {
    const ctx = () => sellerContext(LISTED);
    const mine = async (name: string, overrides: { category?: boolean } = {}) => {
      const product = await draftedProduct('SELLER', LISTED, name);
      if (overrides.category === false) {
        await inUnit(() =>
          copies.save(market, {
            productId: product.state.id,
            content: { texts: { en: { name } }, taxCategoryCode: 't1' },
            contentSchemaVersion: 1,
            baseRevisionId: null,
            lastSavedAt: T0,
            lastSavedByAccountId: uuid7() as Id<'Account'>,
          }),
        );
      }
      return product;
    };
    const alpha = await mine('Alpha Dates');
    const beta = await mine('beta 50%_off Nuts', { category: false });
    const gamma = await mine('Gamma Rice');
    const delta = await mine('Delta Honey');
    await draftedProduct('SELLER', OTHER, 'Alpha Of Another');
    for (const product of [gamma, delta]) {
      const done = await submit.execute(ctx(), {
        productId: product.state.id,
        replacePending: false,
      });
      if (!done.ok) throw new Error(done.error.code);
    }
    // Delta goes live and is paused: it stays in the Live view and carries pausedAt.
    await app.query(
      `UPDATE catalog.products SET status = 'published', published_revision_id = pending_revision_id,
         pending_revision_id = NULL, pending_submitted_at = NULL, paused_at = $2,
         paused_by_account_id = $3 WHERE id = $1`,
      [delta.state.id, T0.toString(), uuid7()],
    );
    await offerOn(alpha.state.id, LISTED, `A-${randomUUID().slice(0, 8)}`);
    await offerOn(beta.state.id, LISTED, `B-${randomUUID().slice(0, 8)}`);
    await offerOn(alpha.state.id, OTHER, `C-${randomUUID().slice(0, 8)}`);

    const query = async (input: Record<string, unknown>) => {
      const answer = await list.execute(ctx(), input);
      if (!answer.ok) throw new Error(JSON.stringify(answer.error));
      if (!('total' in answer.value)) throw new Error('not the list answer');
      return answer.value;
    };
    const names = (value: { items: readonly { name: string | null }[] }) =>
      value.items.map((item) => item.name);

    const all = await query({ page: 1 });
    expect(all.counts).toEqual({ all: 4, drafts: 2, live: 1, inactive: 1, inReview: 1 });
    expect(all.total).toBe(4);
    expect(all).toMatchObject({ page: 1, pageSize: 25 });
    expect(new Set(names(all))).toEqual(
      new Set(['Alpha Dates', 'beta 50%_off Nuts', 'Gamma Rice', 'Delta Honey']),
    );
    const row = all.items.find((item) => item.productId === alpha.state.id)!;
    expect(row).toMatchObject({
      name: 'Alpha Dates',
      draftName: 'Alpha Dates',
      status: 'draft',
      typeCode: 'simple',
      categoryId,
      categoryName: null,
      primaryImageId: null,
      // Only the seller's own Offer counts, not the other seller's on the same product.
      offerCount: 1,
      pausedAt: null,
      hasPendingRevision: false,
    });

    expect(names(await query({ view: 'drafts', sort: 'name' }))).toEqual([
      'Alpha Dates',
      'beta 50%_off Nuts',
    ]);
    const live = await query({ view: 'live' });
    expect(live.items.map((item) => item.productId)).toEqual([delta.state.id]);
    expect(live.items[0]!.pausedAt).toBe(T0.toString());
    expect((await query({ view: 'inactive' })).items.map((item) => item.productId)).toEqual([
      gamma.state.id,
    ]);
    const review = await query({ view: 'in-review' });
    expect(review.items.map((item) => item.productId)).toEqual([gamma.state.id]);
    expect(review.items[0]).toMatchObject({ hasPendingRevision: true, status: 'unpublished' });

    // Search matches the name (any case) or the code, and % and _ are matched as typed.
    expect(names(await query({ q: 'alpha' }))).toEqual(['Alpha Dates']);
    expect(names(await query({ q: '50%_OFF' }))).toEqual(['beta 50%_off Nuts']);
    expect((await query({ q: '5_%' })).total).toBe(0);
    expect((await query({ q: alpha.state.productCode.toLowerCase() })).total).toBe(1);
    // The counts follow the search; the other seller's "Alpha" is never counted.
    expect((await query({ q: 'alpha' })).counts.all).toBe(1);
    // Filters.
    expect((await query({ categoryId })).total).toBe(3);
    expect((await query({ categoryId: uuid7() })).total).toBe(0);
    expect((await query({ paused: true })).items.map((item) => item.productId)).toEqual([
      delta.state.id,
    ]);
    expect((await query({ paused: false })).total).toBe(3);
    expect((await query({ status: 'draft' })).counts).toEqual({
      all: 2,
      drafts: 2,
      live: 0,
      inactive: 0,
      inReview: 0,
    });
    expect((await query({ typeCode: 'simple' })).total).toBe(4);
    expect((await query({ typeCode: 'other' })).total).toBe(0);
    expect((await query({ view: 'live', status: 'draft' })).total).toBe(0);
    // A status filter with a view: the counts follow the filter, the total follows the view.
    const draftsOnly = await query({ view: 'drafts', status: 'draft' });
    expect(draftsOnly.total).toBe(2);
    expect(draftsOnly.counts).toEqual({ all: 2, drafts: 2, live: 0, inactive: 0, inReview: 0 });
    const publishedOnly = await query({ view: 'live', status: 'published' });
    expect(publishedOnly.items.map((item) => item.productId)).toEqual([delta.state.id]);
    expect(publishedOnly.counts).toEqual({ all: 1, drafts: 0, live: 1, inactive: 0, inReview: 0 });
    const reviewUnpublished = await query({ view: 'in-review', status: 'unpublished' });
    expect(reviewUnpublished.total).toBe(1);
    expect(reviewUnpublished.counts).toEqual({
      all: 1,
      drafts: 0,
      live: 0,
      inactive: 1,
      inReview: 1,
    });
    const crossed = await query({ view: 'inactive', status: 'draft' });
    expect(crossed.total).toBe(0);
    expect(crossed.counts).toEqual({ all: 2, drafts: 2, live: 0, inactive: 0, inReview: 0 });
    // Paused with a view: Live holds the paused product; the other tabs count none of it.
    const pausedLive = await query({ view: 'live', paused: true });
    expect(pausedLive.items.map((item) => item.productId)).toEqual([delta.state.id]);
    expect(pausedLive.counts).toEqual({ all: 1, drafts: 0, live: 1, inactive: 0, inReview: 0 });
    const pausedDrafts = await query({ view: 'drafts', paused: true });
    expect(pausedDrafts.total).toBe(0);
    expect(pausedDrafts.counts).toEqual({ all: 1, drafts: 0, live: 1, inactive: 0, inReview: 0 });
    const notPausedLive = await query({ view: 'live', paused: false });
    expect(notPausedLive.total).toBe(0);
    expect(notPausedLive.counts).toEqual({ all: 3, drafts: 2, live: 0, inactive: 1, inReview: 1 });
    // Sort, and paging by page numbers.
    expect(names(await query({ sort: 'name' }))).toEqual([
      'Alpha Dates',
      'beta 50%_off Nuts',
      'Delta Honey',
      'Gamma Rice',
    ]);
    expect(names(await query({ sort: 'name', direction: 'desc' }))[0]).toBe('Gamma Rice');
    const newest = await query({ sort: 'created' });
    expect(newest.items[0]!.productId).toBe(delta.state.id);
    const oldest = await query({ sort: 'created', direction: 'asc' });
    expect(oldest.items[0]!.productId).toBe(alpha.state.id);
    const second = await query({ sort: 'name', page: 2, pageSize: 25 });
    expect(second.items).toEqual([]);
    expect(second.total).toBe(4);
    // Another seller sees none of it.
    const other = await list.execute(sellerContext(uuid7() as Id<'Seller'>), { page: 1 });
    expect(other.ok && 'total' in other.value && other.value.total).toBe(0);
  });

  it('exports the seller’s own products by the list’s selector, in chunks, and only the selected rows', async () => {
    const ctx = () => sellerContext(EXPORTED);
    // 103 products: more than one chunk of 100, in a name order that is not the creation order.
    const made: Product[] = [];
    for (let n = 0; n < 103; n++) {
      made.push(
        await draftedProduct('SELLER', EXPORTED, `Item ${String(102 - n).padStart(3, '0')}`),
      );
    }
    const odd = made[0]!;
    await offerOn(odd.state.id, EXPORTED, `E-${randomUUID().slice(0, 8)}`);
    await offerOn(odd.state.id, OTHER, `F-${randomUUID().slice(0, 8)}`);
    const stranger = await draftedProduct('SELLER', OTHER, 'Item 000 of another');
    const platform = await draftedProduct('PLATFORM', SELLER, 'Platform item');

    const text = async (input: OwnProductsExportInput): Promise<string[]> => {
      const answer = await exporter.execute(ctx(), input);
      if (!answer.ok) throw new Error(JSON.stringify(answer.error));
      let out = '';
      for await (const chunk of answer.value.chunks) out += chunk as string;
      return out.replace('\uFEFF', '').split('\r\n').slice(0, -1);
    };

    const byName = await text({ sort: 'name', columns: 'offers,code' });
    expect(byName).toHaveLength(104);
    expect(byName[0]).toBe('Product,Status,Category,Offers,Product code');
    expect(byName[1]).toBe(`Item 000,Draft,,0,${made[102]!.state.productCode}`);
    expect(byName[103]).toBe(`Item 102,Draft,,1,${odd.state.productCode}`);
    // No product twice and none missing across the chunk boundary, whatever the order.
    for (const sort of ['name', 'created', 'updated'] as const) {
      for (const direction of ['asc', 'desc'] as const) {
        const rows = await text({ sort, direction, columns: 'code' });
        expect(new Set(rows.slice(1).map((line) => line.split(',')[3])).size).toBe(103);
        expect(rows).toHaveLength(104);
      }
    }

    // The tab, search and filters pick the products like the list does.
    expect(await text({ q: 'item 05', columns: 'product' })).toHaveLength(1 + 10);
    expect(await text({ view: 'live', columns: 'product' })).toHaveLength(1);
    expect(await text({ categoryId: uuid7() })).toHaveLength(1);

    // Selected rows: exactly those, in the order of the sort, whatever the tab and search.
    const picked = [made[5]!, made[50]!, odd];
    const selected = await text({
      productIds: picked.map((product) => product.state.id).join(','),
      view: 'live',
      q: 'zzz',
      sort: 'name',
      columns: 'code',
    });
    expect(selected).toEqual([
      'Product,Status,Category,Product code',
      `Item 052,Draft,,${made[50]!.state.productCode}`,
      `Item 097,Draft,,${made[5]!.state.productCode}`,
      `Item 102,Draft,,${odd.state.productCode}`,
    ]);

    // Another seller's product, a PLATFORM product and an unknown id are one answer.
    for (const foreign of [stranger.state.id, platform.state.id, uuid7() as Id<'Product'>]) {
      expect(await exporter.execute(ctx(), { productIds: `${odd.state.id},${foreign}` })).toEqual({
        ok: false,
        error: { code: 'product.not-found' },
      });
    }
    // The other seller exports none of it.
    const none = await exporter.execute(sellerContext(uuid7() as Id<'Seller'>), {});
    expect(none.ok).toBe(true);
  }, 120_000);

  it('keeps an export to the products it matched first when they change while the file streams', async () => {
    const ctx = () => sellerContext(STREAMED);
    // 205 products: three chunks, so two chunks are read after the answer.
    const made: Product[] = [];
    for (let n = 0; n < 205; n++) {
      made.push(await draftedProduct('SELLER', STREAMED, `Stream ${String(n).padStart(3, '0')}`));
    }
    const answer = await exporter.execute(ctx(), {
      sort: 'created',
      direction: 'asc',
      columns: 'code',
    });
    if (!answer.ok) throw new Error(JSON.stringify(answer.error));

    // After the answer (the ids and the first chunk are read): the last product of the file is
    // edited, so it would jump to the front of an offset read in "updated" order and push every
    // other row down by one; one product is discarded; a new one is made.
    await app.query('UPDATE catalog.products SET last_changed_at = $2 WHERE id = $1', [
      made[204]!.state.id,
      T0.add({ hours: 1 }).toString(),
    ]);
    await app.query(
      "UPDATE catalog.products SET status = 'discarded', discarded_at = $2 WHERE id = $1",
      [made[150]!.state.id, T0.add({ hours: 1 }).toString()],
    );
    await draftedProduct('SELLER', STREAMED, 'Stream late arrival');

    let text = '';
    for await (const chunk of answer.value.chunks) text += chunk as string;
    const codes = text
      .replace('\uFEFF', '')
      .split('\r\n')
      .slice(1, -1)
      .map((line) => line.split(',')[3]);
    expect(codes).toEqual(
      made.filter((_, n) => n !== 150).map((product) => product.state.productCode),
    );

    // "updated" order too: the snapshot, not the edit order, decides what the later chunks read.
    const byUpdate = await exporter.execute(ctx(), {
      sort: 'updated',
      direction: 'desc',
      columns: 'code',
    });
    if (!byUpdate.ok) throw new Error(JSON.stringify(byUpdate.error));
    await app.query('UPDATE catalog.products SET last_changed_at = $2 WHERE id = $1', [
      made[0]!.state.id,
      T0.add({ hours: 2 }).toString(),
    ]);
    let later = '';
    for await (const chunk of byUpdate.value.chunks) later += chunk as string;
    const lines = later.replace('\uFEFF', '').split('\r\n').slice(1, -1);
    expect(lines).toHaveLength(205);
    expect(new Set(lines).size).toBe(205);
  }, 120_000);

  async function newCategory(): Promise<string> {
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

  const setDraft = (product: Product, name: string, categoryIds: readonly string[]) =>
    inUnit(() =>
      copies.save(market, {
        productId: product.state.id,
        content: { texts: { en: { name } }, categoryIds: [...categoryIds], taxCategoryCode: 't1' },
        contentSchemaVersion: 1,
        baseRevisionId: null,
        lastSavedAt: T0,
        lastSavedByAccountId: uuid7() as Id<'Account'>,
      }),
    );

  /** Submits the product, then makes the pending revision its published one (as a review would). */
  async function publishedWith(seller: Id<'Seller'>, product: Product) {
    const done = await submit.execute(sellerContext(seller), {
      productId: product.state.id,
      replacePending: false,
    });
    if (!done.ok) throw new Error(done.error.code);
    await app.query(
      `UPDATE catalog.products SET status = 'published', published_revision_id = pending_revision_id,
         pending_revision_id = NULL, pending_submitted_at = NULL WHERE id = $1`,
      [product.state.id],
    );
  }

  it('matches the name and category filters on what the row shows: the draft when there is one, else the shown revision', async () => {
    const second = await newCategory();
    const ctx = () => sellerContext(ALIGNED);
    // Published as "Old Published Name" in the first category; the draft has moved on.
    const edited = await draftedProduct('SELLER', ALIGNED, 'Old Published Name');
    await publishedWith(ALIGNED, edited);
    await setDraft(edited, 'Fresh Draft Name', [second, categoryId]);
    // Published with two categories and no working copy: the revision is what shows.
    const plain = await draftedProduct('SELLER', ALIGNED, 'Revision Only Name');
    await setDraft(plain, 'Revision Only Name', [categoryId, second]);
    await publishedWith(ALIGNED, plain);
    await app.query('DELETE FROM catalog.product_working_copies WHERE product_id = $1', [
      plain.state.id,
    ]);

    const query = async (input: Record<string, unknown>) => {
      const answer = await list.execute(ctx(), { page: 1, ...input });
      if (!answer.ok) throw new Error(JSON.stringify(answer.error));
      if (!('total' in answer.value)) throw new Error('not the list answer');
      return answer.value;
    };
    const idsOf = (value: { items: readonly { productId: string }[] }) =>
      value.items.map((item) => item.productId).sort();

    // The name: the draft's value matches, the superseded published one does not.
    const byDraft = await query({ q: 'fresh draft' });
    expect(byDraft.items.map((item) => [item.productId, item.name])).toEqual([
      [edited.state.id, 'Fresh Draft Name'],
    ]);
    expect((await query({ q: 'old published' })).total).toBe(0);
    expect((await query({ q: 'old published' })).counts.all).toBe(0);
    // Without a draft the shown revision's name matches and is what shows.
    const byRevision = await query({ q: 'revision only' });
    expect(byRevision.items.map((item) => [item.productId, item.name])).toEqual([
      [plain.state.id, 'Revision Only Name'],
    ]);

    // The category: the first one shown. The draft starts with `second`, the revision with the first.
    const inSecond = await query({ categoryId: second });
    expect(idsOf(inSecond)).toEqual([edited.state.id]);
    expect(inSecond.items[0]!.categoryId).toBe(second);
    const inFirst = await query({ categoryId });
    expect(idsOf(inFirst)).toEqual([plain.state.id]);
    expect(inFirst.items[0]!.categoryId).toBe(categoryId);
    expect(inFirst.counts.all).toBe(1);
    // A second-position category matches neither the draft nor the revision.
    expect(inFirst.items.map((item) => item.productId)).not.toContain(edited.state.id);
    expect(inSecond.items.map((item) => item.productId)).not.toContain(plain.state.id);
    // Every filtered row shows the value it was matched on.
    for (const input of [
      { q: 'fresh' },
      { q: 'revision only' },
      { categoryId },
      { categoryId: second },
    ]) {
      const answer = await query(input);
      expect(answer.total).toBeGreaterThan(0);
      for (const item of answer.items) {
        if ('q' in input) expect(item.name?.toLowerCase()).toContain(input.q);
        if ('categoryId' in input) expect(item.categoryId).toBe(input.categoryId);
      }
    }
  });

  it('refuses a name sort over more than 500 matches and sorts exactly 500', async () => {
    const template = await draftedProduct('SELLER', CEILING, 'Template');
    const copy = (count: number) =>
      app.query(
        `INSERT INTO catalog.products (id, market_id, tenant_id, scope, owner_seller_id,
           created_by_seller_id, type_code, variant_model, family_code, product_code, status,
           own_brand, last_changed_at, version, created_at)
         SELECT gen_random_uuid(), market_id, tenant_id, scope, owner_seller_id,
           created_by_seller_id, type_code, variant_model, family_code,
           'Y' || upper(substr(md5(random()::text || g::text), 1, 12)), status,
           own_brand, last_changed_at, 1, created_at
         FROM catalog.products, generate_series(1, $2::int) g WHERE id = $1`,
        [template.state.id, count],
      );
    const ask = async (input: Record<string, unknown>) => {
      const answer = await list.execute(sellerContext(CEILING), { page: 1, ...input });
      if (!answer.ok) return answer.error;
      return answer.value;
    };

    await copy(499);
    const exactly = await ask({ sort: 'name', pageSize: 100 });
    expect(exactly).toMatchObject({ total: 500 });
    expect('items' in exactly ? exactly.items.length : -1).toBe(100);

    await copy(1);
    expect(await ask({ sort: 'name' })).toEqual({
      code: 'validation.failed',
      fields: [{ path: 'sort', code: 'too-broad' }],
    });
    // The other sorts are not limited, and a narrower search sorts by name again.
    expect(await ask({ sort: 'updated', pageSize: 100 })).toMatchObject({ total: 501 });
    expect(await ask({ sort: 'name', q: 'Template' })).toMatchObject({ total: 1 });
  });

  it('sorts by name in the locale’s order, in both directions, with nameless products last', async () => {
    const named = async (name: string) => draftedProduct('SELLER', ORDERED, name);
    await named('banana');
    await named('Apple');
    const cherry = await named('Cherry');
    // Shown from its revision (no draft any more).
    await publishedWith(ORDERED, cherry);
    await app.query('DELETE FROM catalog.product_working_copies WHERE product_id = $1', [
      cherry.state.id,
    ]);
    // A draft without a name, and a product with neither draft nor revision.
    const blank = await named('Blank');
    await inUnit(() =>
      copies.save(market, {
        productId: blank.state.id,
        content: { texts: {}, categoryIds: [categoryId], taxCategoryCode: 't1' },
        contentSchemaVersion: 1,
        baseRevisionId: null,
        lastSavedAt: T0,
        lastSavedByAccountId: uuid7() as Id<'Account'>,
      }),
    );
    const bare = await named('Bare');
    await app.query('DELETE FROM catalog.product_working_copies WHERE product_id = $1', [
      bare.state.id,
    ]);

    const order = async (direction: 'asc' | 'desc') => {
      const answer = await list.execute(sellerContext(ORDERED), {
        page: 1,
        sort: 'name',
        direction,
      });
      if (!answer.ok) throw new Error(JSON.stringify(answer.error));
      if (!('total' in answer.value)) throw new Error('not the list answer');
      return answer.value.items.map((item) => item.name);
    };
    expect(await order('asc')).toEqual(['Apple', 'banana', 'Cherry', null, null]);
    expect(await order('desc')).toEqual(['Cherry', 'banana', 'Apple', null, null]);
  });

  it('reads an own product with its working copy and answers every other id as not found', async () => {
    const product = await draftedProduct('SELLER', SELLER, 'Readable');
    const platform = await draftedProduct('PLATFORM', SELLER, 'Platform');
    const other = await draftedProduct('SELLER', OTHER, 'Other');

    const own = await read.execute(sellerContext(), { productId: product.state.id });
    if (!own.ok) throw new Error(own.error.code);
    expect(own.value).toMatchObject({
      productId: product.state.id,
      status: 'draft',
      maxVariants: 10,
      maxAxes: 2,
      version: product.state.version,
      published: null,
      pending: null,
    });
    expect(own.value.sensitiveFields).toEqual([
      'platform-categories',
      'tax-category',
      'name',
      'primary-image',
      'variant-removed',
      'gtin-changed',
      'axis-added',
      'topics',
      'images',
    ]);
    expect(own.value.workingCopy?.content).toMatchObject({
      texts: { en: { name: 'Readable' } },
    });
    expect(own.value.variants).toHaveLength(1);
    expect(own.value.form.taxCategoryCodes).toEqual(['t1']);
    expect(own.value.form.fields).toEqual(expect.any(Array));
    expect(own.value.form.categories).toEqual(expect.any(Array));

    const missing = { ok: false, error: { code: 'product.not-found' } };
    for (const id of [platform.state.id, other.state.id, uuid7() as Id<'Product'>]) {
      expect(await read.execute(sellerContext(), { productId: id })).toEqual(missing);
    }
  });

  it('reads a platform product with its version and the cap on types, and says when a revision waits', async () => {
    const product = await draftedProduct('PLATFORM', SELLER, 'Platform read');
    const before = await readPlatform.execute(adminContext(), { productId: product.state.id });
    if (!before.ok) throw new Error(before.error.code);
    expect(before.value).toMatchObject({
      productId: product.state.id,
      maxVariants: 10,
      maxAxes: 2,
      version: product.state.version,
      pendingSubmittedAt: null,
    });

    // A revision waits for review: the product row carries when it was submitted.
    const revisionId = uuid7();
    await insert('product_revisions', {
      id: revisionId,
      ...base,
      product_id: product.state.id,
      revision_no: 1,
      revision_kind: 'submission',
      type_code: 'simple',
      base_revision_id: null,
      reverted_from_revision_id: null,
      family_revision_id: familyRevisionId,
      definition_revision_ids: [],
      tax_category_code: 't1',
      attribute_values: '{}',
      field_provenance: null,
      sensitive: true,
      sensitive_reasons: ['name'],
      content_schema_version: 1,
      content_hash: `sha256:${'a'.repeat(64)}`,
      author_kind: 'admin',
      author_account_id: uuid7(),
      acting_admin_account_id: null,
      submitted_at: T0.toString(),
    });
    await app.query(
      `UPDATE catalog.products SET pending_revision_id = $1, pending_submitted_at = $2 WHERE id = $3`,
      [revisionId, T0.toString(), product.state.id],
    );
    const after = await readPlatform.execute(adminContext(), { productId: product.state.id });
    if (!after.ok) throw new Error(after.error.code);
    expect(after.value.pendingSubmittedAt).toBe(T0.toString());
  });

  it('reads the pending revision after a seller submit', async () => {
    const product = await draftedProduct('SELLER', SELLER, 'Submitted');
    const done = await submit.execute(sellerContext(), {
      productId: product.state.id,
      replacePending: false,
    });
    if (!done.ok) throw new Error(done.error.code);
    const own = await read.execute(sellerContext(), { productId: product.state.id });
    if (!own.ok) throw new Error(own.error.code);
    expect(own.value.status).toBe('unpublished');
    expect(own.value.published).toBeNull();
    expect(own.value.pending).toMatchObject({
      revisionId: done.value.revisionId,
      revisionNo: 1,
      authorKind: 'seller',
      sensitive: true,
    });
    expect(own.value.pending?.content.texts['en']?.name).toBe('Submitted');
    const listed = await list.execute(sellerContext(), { limit: 50 });
    const row = listed.ok
      ? listed.value.items.find((item) => item.productId === product.state.id)
      : null;
    expect(row).toMatchObject({ hasPendingRevision: true, hasPublishedRevision: false });
  });

  it('lists and reads the seller’s own Offers with their product label, and hides the rest', async () => {
    const platform = await draftedProduct('PLATFORM', SELLER, 'Labelled');
    const published = await submit.execute(adminContext(), {
      productId: platform.state.id,
      replacePending: false,
    });
    if (!published.ok) throw new Error(published.error.code);
    const mine = await offerOn(platform.state.id, SELLER, `S-${randomUUID().slice(0, 8)}`);
    const theirs = await offerOn(platform.state.id, OTHER, `T-${randomUUID().slice(0, 8)}`);

    // The admin form's totals count every seller's Offers on the product; another product has none.
    expect(await inUnit(() => reader.offerTotalsOfProduct(market, platform.state.id))).toEqual({
      sellerCount: 2,
      offerCount: 2,
    });
    expect(
      await inUnit(() => reader.offerTotalsOfProduct(market, uuid7() as Id<'Product'>)),
    ).toEqual({
      sellerCount: 0,
      offerCount: 0,
    });

    const own = await readOffer.execute(sellerContext(), { offerId: mine.state.id });
    if (!own.ok) throw new Error(own.error.code);
    expect(own.value).toMatchObject({
      offerId: mine.state.id,
      productId: platform.state.id,
      status: 'draft',
      listed: false,
      attestationRecorded: false,
      // No sell-unit row stored: the read lists none (a variant with no row sells, no SKU).
      sellUnits: [],
      description: { en: 'mine' },
      product: { name: 'Labelled', typeCode: 'simple', productCode: platform.state.productCode },
    });
    const notFound = { ok: false, error: { code: 'offer.not-found' } };
    expect(await readOffer.execute(sellerContext(), { offerId: theirs.state.id })).toEqual(
      notFound,
    );
    expect(await readOffer.execute(sellerContext(), { offerId: uuid7() })).toEqual(notFound);

    const listed = await listOffers.execute(sellerContext(), { limit: 50 });
    if (!listed.ok) throw new Error(listed.error.code);
    expect(listed.value.items.map((item) => item.offerId)).toContain(mine.state.id);
    expect(listed.value.items.map((item) => item.offerId)).not.toContain(theirs.state.id);
    expect(listed.value.items[0]!.product.name).toBe('Labelled');
    // The counts are the seller's own Offers only: every draft listed, none of the other seller's.
    const drafts = listed.value.items.filter((item) => item.status === 'draft').length;
    expect(listed.value.counts.draft).toBe(drafts);
    expect(listed.value.counts.published).toBe(0);
    const pending = await inUnit(() => reader.pendingReviewCount(market));
    expect(typeof pending).toBe('number');
  });

  describe('offerTotalsOfProduct', () => {
    const THIRD = '01990000-0000-7000-8000-00000000c5a3' as Id<'Seller'>;
    const actorOf = () => ({ kind: 'seller' as const, accountId: uuid7() as Id<'Account'> });

    /** A Product with no Offers yet in the given Market (this one or the other fixture). */
    async function bareProduct(where: MarketContext): Promise<Id<'Product'>> {
      const created = Product.create({
        id: uuid7() as Id<'Product'>,
        marketId: where.marketId,
        scope: 'PLATFORM',
        sellerId: null,
        handler: simpleProductType,
        familyCode: 'default',
        productCode: `X${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
        variantId: uuid7() as Id<'Variant'>,
        now: T0,
      });
      if (!created.ok) throw new Error(created.error.code);
      await inUnitOf(where, () => products.add(where, created.value));
      return created.value.state.id;
    }

    async function offerIn(
      where: MarketContext,
      productId: Id<'Product'>,
      seller: Id<'Seller'>,
    ): Promise<Offer> {
      const created = Offer.create({
        id: uuid7() as Id<'Offer'>,
        marketId: where.marketId,
        sellerId: seller,
        productId,
        sellerSku: `N-${randomUUID().slice(0, 8)}`,
        conditionCode: 'new',
        description: { en: 'totals' },
        now: T0,
      });
      if (!created.ok) throw new Error(created.error.code);
      const refusal = await inUnitOf(where, () => offers.add(where, created.value, actorOf()));
      if (refusal !== null) throw new Error(refusal);
      return created.value;
    }

    async function remove(where: MarketContext, offer: Offer) {
      await inUnitOf(where, async () => {
        const stored = await offers.findById(where, offer.state.id);
        if (stored === null) throw new Error('offer vanished');
        const deleted = stored.delete({ now: T0 });
        if (!deleted.ok) throw new Error(deleted.error.code);
        const refusal = await offers.save(where, stored, actorOf());
        if (refusal !== null) throw new Error(refusal);
      });
    }

    const totals = (where: MarketContext, productId: Id<'Product'>) =>
      inUnitOf(where, () => reader.offerTotalsOfProduct(where, productId));

    it('counts one Offer per seller: a second open Offer of a seller on the product is refused', async () => {
      // OFR-02: one non-deleted Offer per (Market, seller, product), so offerCount equals
      // sellerCount among open Offers; the totals query cannot see two Offers of one seller.
      const productId = await bareProduct(market);
      await offerIn(market, productId, SELLER);
      await offerIn(market, productId, OTHER);
      await expect(offerIn(market, productId, SELLER)).rejects.toThrow('offer.exists-for-product');
      expect(await totals(market, productId)).toEqual({ sellerCount: 2, offerCount: 2 });
    });

    it('leaves deleted Offers out, and a seller whose only Offer is deleted is not a seller', async () => {
      const productId = await bareProduct(market);
      const kept = await offerIn(market, productId, SELLER);
      const gone = await offerIn(market, productId, OTHER);
      expect(await totals(market, productId)).toEqual({ sellerCount: 2, offerCount: 2 });
      await remove(market, gone);
      expect(await totals(market, productId)).toEqual({ sellerCount: 1, offerCount: 1 });
      await remove(market, kept);
      expect(await totals(market, productId)).toEqual({ sellerCount: 0, offerCount: 0 });
      // A seller with a deleted Offer and a new open one on the same product counts once.
      await offerIn(market, productId, SELLER);
      await offerIn(market, productId, THIRD);
      expect(await totals(market, productId)).toEqual({ sellerCount: 2, offerCount: 2 });
    });

    it('counts only this Market: the other Market fixture keeps its own numbers', async () => {
      const there = marketOf(otherMarketOf(code));
      const mine = await bareProduct(market);
      const theirs = await bareProduct(there);
      await offerIn(market, mine, SELLER);
      await offerIn(there, theirs, SELLER);
      await offerIn(there, theirs, OTHER);
      await offerIn(there, theirs, THIRD);
      expect(await totals(market, mine)).toEqual({ sellerCount: 1, offerCount: 1 });
      expect(await totals(there, theirs)).toEqual({ sellerCount: 3, offerCount: 3 });
      // Each Market's reader call sees nothing of the other Market's Product, whatever its Offers.
      expect(await totals(market, theirs)).toEqual({ sellerCount: 0, offerCount: 0 });
      expect(await totals(there, mine)).toEqual({ sellerCount: 0, offerCount: 0 });
    });
  });
});
