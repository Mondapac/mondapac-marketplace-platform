import { randomUUID } from 'node:crypto';
import { Temporal, ok, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { OwnOfferRead } from '../../src/modules/catalog/application/use-cases/own-offer-read.use-case';
import { OwnOffersList } from '../../src/modules/catalog/application/use-cases/own-offers-list.use-case';
import { OwnProductRead } from '../../src/modules/catalog/application/use-cases/own-product-read.use-case';
import { OwnProductsList } from '../../src/modules/catalog/application/use-cases/own-products-list.use-case';
import { Offer } from '../../src/modules/catalog/domain/offer';
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
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Catalog slice 7 reads (own-products.list, own-product.read, own-offers.list, own-offer.read) on PostgreSQL, for both Market fixtures: the submit
// service end to end over the real stores (freeze, claim check, revision rows, product pointer,
// events) and the loss of a race on the revision number mapped to a stale conflict.

const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');
const clock = new FixedClock(T0);
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
let sequence = 0;
const SELLER = '01990000-0000-7000-8000-00000000b001' as Id<'Seller'>;
const OTHER = '01990000-0000-7000-8000-00000000b002' as Id<'Seller'>;
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
  let read: OwnProductRead;
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
    read = new OwnProductRead(gate, {
      unitOfWork: persistence.unitOfWork,
      products,
      workingCopies: copies,
      revisions,
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
      published: null,
      pending: null,
    });
    expect(own.value.sensitiveFields).toEqual([
      'platform-categories',
      'tax-category',
      'name',
      'primary-image',
      'variant-removed',
      'images',
    ]);
    expect(own.value.workingCopy?.content).toMatchObject({
      texts: { en: { name: 'Readable' } },
    });
    expect(own.value.variants).toHaveLength(1);

    const missing = { ok: false, error: { code: 'product.not-found' } };
    for (const id of [platform.state.id, other.state.id, uuid7() as Id<'Product'>]) {
      expect(await read.execute(sellerContext(), { productId: id })).toEqual(missing);
    }
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

    const own = await readOffer.execute(sellerContext(), { offerId: mine.state.id });
    if (!own.ok) throw new Error(own.error.code);
    expect(own.value).toMatchObject({
      offerId: mine.state.id,
      productId: platform.state.id,
      status: 'draft',
      listed: false,
      attestationRecorded: false,
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
  });
});
