import { ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { SearchDependencies } from '../../src/modules/search/application/search-dependencies';
import { SearchProducts } from '../../src/modules/search/application/use-cases/search-products.use-case';
import { SyncOfferDocuments } from '../../src/modules/search/application/use-cases/sync-offer-documents.use-case';
import type { FeedFacts } from '../../src/modules/search/application/ports/offer-feed';
import type { OfferDocument } from '../../src/modules/search/domain/offer-document';
import { ConfigSearchPolicy } from '../../src/modules/search/infrastructure/config-search-policy';
import { PrismaOfferDocumentRepository } from '../../src/modules/search/infrastructure/prisma-offer-document.repository';
import { PrismaShelfDocumentsReader } from '../../src/modules/search/infrastructure/prisma-shelf-documents.reader';
import { PrismaOfferVariantReader } from '../../src/modules/search/infrastructure/prisma-offer-variant.reader';
import { PostgresOfferSearchIndex } from '../../src/modules/search/infrastructure/postgres-offer-search-index';
import { RawStoreSearchReader } from '../../src/modules/search/infrastructure/raw-store-search.reader';
import { PrismaStoreDocumentRepository } from '../../src/modules/search/infrastructure/prisma-store-document.repository';
import { StoreRowConflictError } from '../../src/modules/search/application/ports/store-document.repository';
import { RawOfferScopeReader } from '../../src/modules/search/infrastructure/raw-offer-scope.reader';
import { RawOfferFacetReader } from '../../src/modules/search/infrastructure/raw-offer-facet.reader';
import { RawOfferSearchReader } from '../../src/modules/search/infrastructure/raw-offer-search.reader';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PrismaRawReadPort } from '../../src/platform/persistence/raw-reads/prisma-raw-read-port';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../support/test-config';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { searchDocumentsTestDatabaseUrl } from './test-database';

// The read model search.offer_documents on PostgreSQL, as the application role, for both Market
// fixtures: the trigger-built vector, ranked text queries with each Market's configuration,
// category filter, stable pages, Market isolation, hostile query text, and the table's CHECKs.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-15T10:00:00Z');
const CHECK = '23514';

let counter = 0;
const id = <T extends string>(): Id<T> => {
  counter += 1;
  const parsed = parseId(
    `01990000-0000-7000-8000-${(0xd0000 + counter).toString(16).padStart(12, '0')}`,
  );
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};

describe.each(TEST_MARKETS)('search read model in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const policy = new ConfigSearchPolicy(markets);
  const settings = policy.settings(market);
  let db: Persistence;
  let documents: PrismaOfferDocumentRepository;
  let reader: RawOfferSearchReader;
  let facetReader: RawOfferFacetReader;
  let shelves: PrismaShelfDocumentsReader;
  let sql: Client;

  const doc = (overrides: Partial<OfferDocument> & { name: string }): OfferDocument => ({
    offerId: id<'Offer'>(),
    productId: id<'Product'>(),
    sellerId: id<'Seller'>(),
    locale: settings.locale,
    shortText: null,
    categoryIds: [],
    textSearchConfig: settings.textSearchConfig,
    searchText: null,
    facetCodes: [],
    numbers: {},
    variants: [],
    cultureCodes: [],
    ...overrides,
  });
  const inUnit = async <T>(target: MarketContext, work: () => Promise<T>, readOnly = false) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()), { readOnly });
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const seed = (target: MarketContext, ...docs: OfferDocument[]) =>
    inUnit(target, async () => {
      for (const d of docs) await documents.upsert(target, d, T0);
    });
  const find = (
    text: string | null,
    options: {
      categoryIds?: readonly Id<'Category'>[];
      limit?: number;
      offset?: number;
      on?: MarketContext;
    } = {},
  ) =>
    inUnit(
      options.on ?? market,
      () =>
        reader.search(options.on ?? market, {
          textSearchConfig:
            markets.get((options.on ?? market).marketId).search?.textSearchConfig ?? 'simple',
          text,
          categoryIds: options.categoryIds ?? null,
          limit: options.limit ?? 49,
          offset: options.offset ?? 0,
        }),
      true,
    );
  const names = (hits: readonly { name: string }[]) => hits.map((hit) => hit.name);

  beforeAll(async () => {
    db = createPersistence({ databaseUrl: searchDocumentsTestDatabaseUrl() });
    documents = new PrismaOfferDocumentRepository(db.service);
    shelves = new PrismaShelfDocumentsReader(db.service);
    reader = new RawOfferSearchReader(new PrismaRawReadPort(db.root).forModule('search'));
    facetReader = new RawOfferFacetReader(new PrismaRawReadPort(db.root).forModule('search'));
    sql = new Client({ connectionString: searchDocumentsTestDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });
  beforeEach(async () => {
    await sql.query('DELETE FROM "search"."offer_documents"');
    await sql.query('DELETE FROM "search"."store_documents"');
  });

  it('builds the vector in the database from the name (weight A) and the short text (B)', async () => {
    const d = doc({ name: 'Halal Sausages', shortText: 'Twelve pack' });
    await seed(market, d);

    const row = await sql.query<{ v: string }>(
      'SELECT search_vector::text AS v FROM "search"."offer_documents" WHERE offer_id = $1 AND market_id = $2',
      [d.offerId, market.marketId],
    );

    expect(row.rows[0]?.v).toMatch(/'halal':1A/);
    expect(row.rows[0]?.v).toMatch(/'pack':\d+B/);
  });

  it('ranks a name match above a short-text match, and breaks ties by Offer id', async () => {
    const inName = doc({ name: 'Beef sausages', shortText: 'Frozen' });
    const inText = doc({ name: 'Frozen pack', shortText: 'Beef sausages' });
    const unrelated = doc({ name: 'Lamb chops', shortText: 'Fresh' });
    const twinA = doc({ name: 'Twin lamb' });
    const twinB = doc({ name: 'Twin lamb' });
    await seed(market, inText, unrelated, inName, twinB, twinA);

    const sausages = await find('beef sausages');
    const twins = await find('twin');

    expect(sausages.map((hit) => hit.offerId)).toEqual([inName.offerId, inText.offerId]);
    expect(sausages[0]!.rank).toBeGreaterThan(sausages[1]!.rank);
    expect(twins.map((hit) => hit.offerId)).toEqual([twinA.offerId, twinB.offerId].sort());
  });

  it("uses the Market's text search configuration (english stems, simple does not)", async () => {
    await seed(market, doc({ name: 'Running shoes' }));

    const hits = await find('run');

    expect(hits.length).toBe(settings.textSearchConfig === 'english' ? 1 : 0);
    expect(await find('running')).toHaveLength(1);
  });

  it('understands web-search syntax: quotes, OR and exclusion', async () => {
    await seed(
      market,
      doc({ name: 'Red apple' }),
      doc({ name: 'Green apple' }),
      doc({ name: 'Red pear' }),
    );

    expect(names(await find('"red apple"'))).toEqual(['Red apple']);
    expect(names(await find('apple -green'))).toEqual(['Red apple']);
    expect((await find('pear OR green')).length).toBe(2);
  });

  it('filters by category, with or without text, and browses a category by name', async () => {
    const tea = id<'Category'>();
    const coffee = id<'Category'>();
    await seed(
      market,
      doc({ name: 'Zebra tea', categoryIds: [tea] }),
      doc({ name: 'Apple tea', categoryIds: [tea, coffee] }),
      doc({ name: 'Mocha', categoryIds: [coffee] }),
      doc({ name: 'Uncategorised tea' }),
    );

    expect(names(await find('tea', { categoryIds: [tea] }))).toHaveLength(2);
    expect(names(await find('tea', { categoryIds: [coffee] }))).toEqual(['Apple tea']);
    expect(names(await find(null, { categoryIds: [tea] }))).toEqual(['Apple tea', 'Zebra tea']);
    expect(names(await find(null, { categoryIds: [coffee] }))).toEqual(['Apple tea', 'Mocha']);
    expect(await find(null, { categoryIds: [id<'Category'>()] })).toEqual([]);
  });

  it('matches a document in any of the given categories (a category and its subcategories), once', async () => {
    const pantry = id<'Category'>();
    const pasta = id<'Category'>();
    const rice = id<'Category'>();
    await seed(
      market,
      doc({ name: 'Spaghetti', categoryIds: [pasta] }),
      doc({ name: 'Basmati rice', categoryIds: [rice] }),
      doc({ name: 'Pantry staples box', categoryIds: [pantry, pasta, rice] }),
      doc({ name: 'Garden hose' }),
    );
    const subtree = [pantry, pasta, rice];

    expect(names(await find(null, { categoryIds: subtree }))).toEqual([
      'Basmati rice',
      'Pantry staples box',
      'Spaghetti',
    ]);
    expect(names(await find('spaghetti OR rice', { categoryIds: subtree })).sort()).toEqual([
      'Basmati rice',
      'Spaghetti',
    ]);
    expect(names(await find(null, { categoryIds: [pantry] }))).toEqual(['Pantry staples box']);
  });

  it('refuses an empty or oversized category filter before any statement', async () => {
    const ask = (categoryIds: readonly Id<'Category'>[]) =>
      reader.search(market, {
        textSearchConfig: settings.textSearchConfig,
        text: null,
        categoryIds,
        limit: 10,
        offset: 0,
      });

    await expect(ask([])).rejects.toThrow(RangeError);
    await expect(ask(Array.from({ length: 1001 }, () => id<'Category'>()))).rejects.toThrow(
      RangeError,
    );
    const full = Array.from({ length: 1000 }, () => id<'Category'>());
    expect(await inUnit(market, () => ask(full), true)).toEqual([]);
  });

  it('pages stably: no Offer twice, none missing, the same order every time', async () => {
    const all = Array.from({ length: 7 }, () => doc({ name: 'Identical gadget' }));
    await seed(market, ...all);
    const expected = all.map((d) => d.offerId).sort();

    const pages = [];
    for (let page = 0; page < 4; page += 1) {
      pages.push(await find('gadget', { limit: 3, offset: page * 3 }));
    }
    const again = await find('gadget', { limit: 3, offset: 3 });

    expect(pages.map((p) => p.length)).toEqual([3, 3, 1, 0]);
    expect(pages.flat().map((hit) => hit.offerId)).toEqual(expected);
    expect(again.map((hit) => hit.offerId)).toEqual(pages[1]!.map((hit) => hit.offerId));
  });

  it('never returns the documents of the other Market, even for the same Offer id', async () => {
    const mine = doc({ name: 'Shared word alpha' });
    const theirs = { ...doc({ name: 'Shared word beta' }), offerId: mine.offerId };
    await seed(market, mine);
    const theirConfig = markets.get(other.marketId).search?.textSearchConfig ?? 'simple';
    await seed(
      other,
      { ...theirs, textSearchConfig: theirConfig },
      doc({ name: 'Foreign shared', textSearchConfig: theirConfig }),
    );

    expect(names(await find('shared'))).toEqual(['Shared word alpha']);
    expect(names(await find('shared', { on: other })).sort()).toEqual([
      'Foreign shared',
      'Shared word beta',
    ]);
    expect(await find(null, { categoryIds: [mine.categoryIds[0] ?? id<'Category'>()] })).toEqual(
      [],
    );
  });

  it.each([
    "'; DROP TABLE search.offer_documents; --",
    "' OR '1'='1",
    '") OR 1=1 --',
    'a:* & b | !c <-> d',
    String.raw`back\\slash %_ ' "quote`,
    '((((( unbalanced',
    '!!!',
    'the',
  ])('treats %j as plain text: no error, no injection', async (hostile) => {
    await seed(market, doc({ name: 'Harmless product' }));

    const hits = await find(hostile);
    const still = await sql.query('SELECT count(*)::int AS n FROM "search"."offer_documents"');

    expect(hits).toEqual([]);
    expect(still.rows[0]).toEqual({ n: 1 });
  });

  it('refuses limits and offsets outside the page bounds before any statement', async () => {
    const ask = (limit: number, offset: number) =>
      reader.search(market, {
        textSearchConfig: settings.textSearchConfig,
        text: 'x',
        categoryIds: null,
        limit,
        offset,
      });

    await expect(ask(0, 0)).rejects.toThrow(RangeError);
    await expect(ask(50, 0)).rejects.toThrow(RangeError);
    await expect(ask(10, -1)).rejects.toThrow(RangeError);
    await expect(ask(10, 1.5)).rejects.toThrow(RangeError);
    await expect(ask(10, 4801)).rejects.toThrow(RangeError);
  });

  it('updates the vector on upsert, and removes documents', async () => {
    const d = doc({ name: 'Original name' });
    await seed(market, d);
    await seed(market, { ...d, name: 'Renamed item' });

    expect(await find('original')).toEqual([]);
    expect(names(await find('renamed'))).toEqual(['Renamed item']);

    const removed = await inUnit(market, () =>
      documents.deleteMany(market, [d.offerId, id<'Offer'>()]),
    );
    expect(removed).toBe(1);
    expect(await find('renamed')).toEqual([]);
  });

  it('lists the Offers of a seller, in this Market only', async () => {
    const seller = id<'Seller'>();
    const a = doc({ name: 'Seller one', sellerId: seller });
    const b = doc({ name: 'Seller two', sellerId: seller });
    await seed(market, a, b, doc({ name: 'Someone else' }));
    await seed(other, doc({ name: 'Elsewhere', sellerId: seller }));

    const ofSeller = await inUnit(market, () => documents.offerIdsOfSeller(market, seller), true);

    expect([...ofSeller].sort()).toEqual([a.offerId, b.offerId].sort());
  });

  it('lists the Offers of a product and deletes only documents older than a rebuild start', async () => {
    const product = id<'Product'>();
    const a = doc({ name: 'Old one', productId: product });
    const b = doc({ name: 'Old two', productId: product });
    const c = doc({ name: 'Fresh three' });
    await seed(market, a, b);
    await inUnit(market, () => documents.upsert(market, c, T0.add({ hours: 1 })));

    const ofProduct = await inUnit(
      market,
      () => documents.offerIdsOfProduct(market, product),
      true,
    );
    const removed = await inUnit(market, () =>
      documents.deleteIndexedBefore(market, T0.add({ minutes: 30 }), 1),
    );
    const removedMore = await inUnit(market, () =>
      documents.deleteIndexedBefore(market, T0.add({ minutes: 30 }), 10),
    );

    expect([...ofProduct].sort()).toEqual([a.offerId, b.offerId].sort());
    expect([removed, removedMore]).toEqual([1, 1]);
    expect(names(await find('three'))).toEqual(['Fresh three']);
  });

  it('refuses rows the application would never write (CHECKs)', async () => {
    const base = doc({ name: 'Check me' });
    const insert = (overrides: Record<string, unknown>) => {
      const row = {
        market_id: market.marketId,
        tenant_id: market.tenantId,
        offer_id: id<'Offer'>(),
        product_id: base.productId,
        seller_id: base.sellerId,
        locale: settings.locale,
        name: 'Check me',
        short_text: null,
        category_ids: [],
        text_search_config: settings.textSearchConfig,
        indexed_at: new Date(T0.epochMilliseconds),
        ...overrides,
      };
      return sql.query(
        `INSERT INTO "search"."offer_documents" (market_id, tenant_id, offer_id, product_id, seller_id,
           locale, name, short_text, category_ids, text_search_config, indexed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid[],$10,$11)`,
        Object.values(row),
      );
    };

    // An unknown name fails in the trigger's cast; a real one off the list fails the CHECK.
    await expect(insert({ text_search_config: 'klingon' })).rejects.toMatchObject({
      code: '42704',
    });
    await expect(insert({ text_search_config: 'pg_catalog.english' })).rejects.toMatchObject({
      code: CHECK,
    });
    await expect(insert({ name: '' })).rejects.toMatchObject({ code: CHECK });
    await expect(insert({ locale: 'english' })).rejects.toMatchObject({ code: CHECK });
    await expect(insert({ market_id: 'au' })).rejects.toMatchObject({ code: CHECK });
    await expect(insert({ short_text: '' })).rejects.toMatchObject({ code: CHECK });
    await expect(insert({})).resolves.toBeDefined();
  });

  it('answers a visitor through SearchProducts on the real index, hiding what catalog hides', async () => {
    const shown = doc({ name: 'Visible mug' });
    const hidden = doc({ name: 'Hidden mug' });
    await seed(market, shown, hidden);
    const deps: SearchDependencies = {
      unitOfWork: db.unitOfWork,
      documents,
      index: new PostgresOfferSearchIndex(
        reader,
        facetReader,
        new RawOfferScopeReader(new PrismaRawReadPort(db.root).forModule('search')),
        new RawStoreSearchReader(new PrismaRawReadPort(db.root).forModule('search')),
      ),
      storeDocuments: new PrismaStoreDocumentRepository(db.service),
      categoryTree: { tree: () => Promise.resolve([]) },
      cultures: {
        visibleCodes: () => Promise.resolve(new Map()),
        codeOf: () => Promise.resolve(undefined),
      },
      storeDirectory: { publicStores: () => Promise.resolve(new Map()) },
      filterSource: { filters: () => Promise.resolve([]) },
      policy,
      feed: { facts: () => Promise.resolve(null), publishedIds: () => Promise.resolve(null) },
      visibility: {
        visible: (_context: CallContext, offers) =>
          Promise.resolve(
            new Set(offers.map((o) => o.offerId).filter((o) => o !== hidden.offerId)),
          ),
      },
      sellers: { eligible: () => Promise.resolve(null) },
      clock: new FixedClock(T0),
      shelves,
      stores: { sellerIdOf: () => Promise.resolve({ sellerId: null }) },
      brands: { productIdsOf: () => Promise.resolve({ productIds: [], truncated: false }) },
      images: { of: () => Promise.resolve(new Map()) },
      categories: { subtreeOf: (_context, categoryId) => Promise.resolve([categoryId]) },
      sellUnits: { states: () => Promise.resolve(null) },
      variants: new PrismaOfferVariantReader(db.service),
    };
    const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
    const visitor = testCallContext(market, 'anonymous', 'search-db-visitor-1');

    const result = await new SearchProducts(gate, deps).execute(visitor, { q: 'mug', pageSize: 5 });

    expect(result.ok && result.value.items.map((item) => item.name)).toEqual(['Visible mug']);
    expect(result.ok && result.value.hasMore).toBe(false);
  });

  describe('browsing the Offers of one store', () => {
    const browse = (
      sellerId: Id<'Seller'>,
      options: {
        categoryIds?: readonly Id<'Category'>[];
        limit?: number;
        offset?: number;
        on?: MarketContext;
      } = {},
    ) =>
      inUnit(
        options.on ?? market,
        () =>
          shelves.browseBySeller(
            options.on ?? market,
            sellerId,
            options.categoryIds ?? null,
            options.limit ?? 49,
            options.offset ?? 0,
          ),
        true,
      );

    it("lists one seller's Offers by name then Offer id, and pages by offset", async () => {
      const seller = id<'Seller'>();
      const otherSeller = id<'Seller'>();
      await seed(
        market,
        doc({ name: 'Cherry tea', sellerId: seller }),
        doc({ name: 'Apple tea', sellerId: seller }),
        doc({ name: 'Banana tea', sellerId: seller }),
        doc({ name: 'Another seller tea', sellerId: otherSeller }),
      );

      expect(names(await browse(seller))).toEqual(['Apple tea', 'Banana tea', 'Cherry tea']);
      expect(names(await browse(seller, { limit: 2, offset: 0 }))).toEqual([
        'Apple tea',
        'Banana tea',
      ]);
      expect(names(await browse(seller, { limit: 2, offset: 2 }))).toEqual(['Cherry tea']);
      expect(await browse(seller, { offset: 3 })).toEqual([]);
    });

    it('narrows to one category, and gives the same Offer id order for equal names', async () => {
      const seller = id<'Seller'>();
      const tea = id<'Category'>();
      const coffee = id<'Category'>();
      const first = doc({ name: 'Same name', sellerId: seller, categoryIds: [tea] });
      const second = doc({ name: 'Same name', sellerId: seller, categoryIds: [tea, coffee] });
      await seed(
        market,
        second,
        first,
        doc({ name: 'Coffee only', sellerId: seller, categoryIds: [coffee] }),
      );

      const inTea = await browse(seller, { categoryIds: [tea] });
      expect(inTea.map((hit) => hit.offerId)).toEqual([first.offerId, second.offerId].sort());
      expect(names(await browse(seller, { categoryIds: [coffee] }))).toEqual([
        'Coffee only',
        'Same name',
      ]);
      expect(await browse(seller, { categoryIds: [id<'Category'>()] })).toEqual([]);
      expect(names(await browse(seller, { categoryIds: [tea, coffee] }))).toEqual([
        'Coffee only',
        'Same name',
        'Same name',
      ]);
    });

    it("never shows another Market's documents, even for the same seller id", async () => {
      const seller = id<'Seller'>();
      await seed(market, doc({ name: 'Here', sellerId: seller }));
      await seed(other, doc({ name: 'There', sellerId: seller }));

      expect(names(await browse(seller))).toEqual(['Here']);
      expect(names(await browse(seller, { on: other }))).toEqual(['There']);
    });
  });

  describe('browseByProducts', () => {
    const browseProducts = (
      productIds: readonly Id<'Product'>[],
      options: {
        categoryIds?: readonly Id<'Category'>[];
        limit?: number;
        offset?: number;
        on?: MarketContext;
      } = {},
    ) =>
      inUnit(
        options.on ?? market,
        () =>
          shelves.browseByProducts(
            options.on ?? market,
            productIds,
            options.categoryIds ?? null,
            options.limit ?? 49,
            options.offset ?? 0,
          ),
        true,
      );

    it('lists the Offers of the given products only, by name then Offer id, and pages by offset', async () => {
      const [a, b, c] = [id<'Product'>(), id<'Product'>(), id<'Product'>()];
      await seed(
        market,
        doc({ name: 'Cherry tea', productId: a }),
        doc({ name: 'Apple tea', productId: b }),
        doc({ name: 'Banana tea', productId: a }),
        doc({ name: 'Not in the brand', productId: c }),
      );

      expect(names(await browseProducts([a, b]))).toEqual([
        'Apple tea',
        'Banana tea',
        'Cherry tea',
      ]);
      expect(names(await browseProducts([a, b], { limit: 2 }))).toEqual([
        'Apple tea',
        'Banana tea',
      ]);
      expect(names(await browseProducts([a, b], { limit: 2, offset: 2 }))).toEqual(['Cherry tea']);
      expect(await browseProducts([a, b], { offset: 3 })).toEqual([]);
    });

    it('answers nothing for no product ids, and narrows to a category', async () => {
      const [a, b] = [id<'Product'>(), id<'Product'>()];
      const tea = id<'Category'>();
      await seed(
        market,
        doc({ name: 'Tea one', productId: a, categoryIds: [tea] }),
        doc({ name: 'Other one', productId: b, categoryIds: [] }),
      );

      expect(await browseProducts([])).toEqual([]);
      expect(names(await browseProducts([a, b], { categoryIds: [tea] }))).toEqual(['Tea one']);
      expect(await browseProducts([a, b], { categoryIds: [id<'Category'>()] })).toEqual([]);
    });

    it("never shows another Market's documents, even for the same product id", async () => {
      const product = id<'Product'>();
      await seed(market, doc({ name: 'Here', productId: product }));
      await seed(other, doc({ name: 'There', productId: product }));

      expect(names(await browseProducts([product]))).toEqual(['Here']);
      expect(names(await browseProducts([product], { on: other }))).toEqual(['There']);
    });
  });

  describe('store rows and the store query (search 1a)', () => {
    let storeDocs: PrismaStoreDocumentRepository;
    let storeReader: RawStoreSearchReader;
    let scopeReader: RawOfferScopeReader;
    const store = (sellerId: Id<'Seller'>, slug: string, name: string) => ({
      sellerId,
      slug,
      name,
      textSearchConfig: settings.textSearchConfig,
    });
    const findStores = (text: string, on: MarketContext = market, limit = 25, offset = 0) =>
      inUnit(
        on,
        () =>
          storeReader.searchStores(on, {
            textSearchConfig: markets.get(on.marketId).search?.textSearchConfig ?? 'simple',
            text,
            limit,
            offset,
          }),
        true,
      );
    const seedStores = (target: MarketContext, ...rows: ReturnType<typeof store>[]) =>
      inUnit(target, () => storeDocs.upsertMany(target, rows, T0));

    beforeAll(() => {
      storeDocs = new PrismaStoreDocumentRepository(db.service);
      storeReader = new RawStoreSearchReader(new PrismaRawReadPort(db.root).forModule('search'));
      scopeReader = new RawOfferScopeReader(new PrismaRawReadPort(db.root).forModule('search'));
    });

    it('builds the store vector in the database from the name', async () => {
      const seller = id<'Seller'>();
      await seedStores(market, store(seller, 'alis-butcher', "Ali's Butcher"));

      const row = await sql.query<{ v: string }>(
        'SELECT search_vector::text AS v FROM "search"."store_documents" WHERE seller_id = $1 AND market_id = $2',
        [seller, market.marketId],
      );

      expect(row.rows[0]?.v).toMatch(/'butcher':\d+A/);
    });

    it('finds a store by name only while it has an indexed Offer, and ranks by relevance', async () => {
      const [withOffer, without] = [id<'Seller'>(), id<'Seller'>()];
      await seedStores(
        market,
        store(withOffer, 'green-butcher', 'Green Butcher'),
        store(without, 'empty-butcher', 'Empty Butcher'),
      );
      await seed(market, doc({ name: 'Mince', sellerId: withOffer }));

      const hits = await findStores('butcher');

      expect(hits.map((hit) => hit.slug)).toEqual(['green-butcher']);
      expect(hits[0]?.sellerId).toBe(withOffer);
      expect(await findStores('nothingmatches')).toEqual([]);
    });

    it('pages stably and never shows another Market', async () => {
      const sellers = [id<'Seller'>(), id<'Seller'>(), id<'Seller'>()];
      await seedStores(
        market,
        ...sellers.map((seller, n) => store(seller, `fresh-store-${n}`, 'Fresh Store')),
      );
      const otherSeller = id<'Seller'>();
      await seedStores(other, store(otherSeller, 'fresh-store-x', 'Fresh Store'));
      await seed(market, ...sellers.map((sellerId) => doc({ name: 'Bread', sellerId })));
      await seed(other, doc({ name: 'Bread', sellerId: otherSeller }));

      expect((await findStores('fresh', other)).map((hit) => hit.sellerId)).toEqual([otherSeller]);
      const first = await findStores('fresh', market, 2, 0);
      const second = await findStores('fresh', market, 2, 2);

      expect([...first, ...second].map((hit) => hit.sellerId)).toEqual([...sellers].sort());
    });

    it('hands a store address from one seller to another, and keeps the address unique', async () => {
      const [first, second] = [id<'Seller'>(), id<'Seller'>()];
      await seedStores(market, store(first, 'same-address', 'First'));
      await seedStores(market, store(second, 'same-address', 'Second'));

      const rows = await sql.query<{ seller_id: string }>(
        'SELECT seller_id FROM "search"."store_documents" WHERE market_id = $1 AND slug = $2',
        [market.marketId, 'same-address'],
      );
      expect(rows.rows.map((row) => row.seller_id)).toEqual([second]);
    });

    it('throws StoreRowConflictError when a concurrent sync hands the address over first', async () => {
      const [mine, theirs] = [id<'Seller'>(), id<'Seller'>()];
      // Another sync holds an uncommitted row of the same address for another seller.
      await sql.query('BEGIN');
      let open = true;
      try {
        const holder = await sql.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const holderPid = holder.rows[0]!.pid;
        await sql.query(
          `INSERT INTO "search"."store_documents"
             (market_id, tenant_id, seller_id, slug, name, text_search_config, indexed_at)
           VALUES ($1, $2, $3, 'race-address', 'Theirs', $4, now())`,
          [market.marketId, market.tenantId, theirs, settings.textSearchConfig],
        );
        const write = seedStores(market, store(mine, 'race-address', 'Mine'));
        const settled = write.then(
          () => 'written',
          (error: unknown) => error,
        );
        // Wait until this write is really blocked on the other row's unique key (a backend that
        // the holder blocks), never on a fixed delay; then the holder commits.
        const watcher = new Client({ connectionString: searchDocumentsTestDatabaseUrl() });
        await watcher.connect();
        try {
          const deadline = Date.now() + 10_000;
          for (;;) {
            const blocked = await watcher.query(
              'SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
              [holderPid],
            );
            if (blocked.rowCount !== 0) break;
            if (Date.now() > deadline) throw new Error('the store write never waited');
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        } finally {
          await watcher.end();
        }
        await sql.query('COMMIT');
        open = false;

        expect(await settled).toBeInstanceOf(StoreRowConflictError);
      } finally {
        if (open) await sql.query('ROLLBACK');
      }
      const rows = await sql.query<{ seller_id: string }>(
        'SELECT seller_id FROM "search"."store_documents" WHERE market_id = $1 AND slug = $2',
        [market.marketId, 'race-address'],
      );
      expect(rows.rows.map((row) => row.seller_id)).toEqual([theirs]);
    });

    it('counts the indexed Offers of sellers, deletes by seller and deletes stale rows', async () => {
      const [one, two] = [id<'Seller'>(), id<'Seller'>()];
      await seedStores(
        market,
        store(one, 'store-one', 'Store One'),
        store(two, 'store-two', 'Store Two'),
      );
      await seed(
        market,
        doc({ name: 'A', sellerId: one }),
        doc({ name: 'B', sellerId: one }),
        doc({ name: 'C', sellerId: two }),
      );

      const counts = await inUnit(market, () => storeDocs.offerCounts(market, [one, two]), true);
      expect([...counts]).toEqual(
        expect.arrayContaining([
          [one, 2],
          [two, 1],
        ]),
      );
      expect(await inUnit(market, () => storeDocs.deleteMany(market, [one]))).toBe(1);
      const stale = await inUnit(market, () =>
        storeDocs.deleteIndexedBefore(market, T0.add({ hours: 1 }), 10),
      );
      expect(stale).toBe(1);
    });

    it('refuses a store row the application would never write (CHECKs)', async () => {
      const bad = (slug: string, name: string) =>
        sql.query(
          `INSERT INTO "search"."store_documents"
             (market_id, tenant_id, seller_id, slug, name, text_search_config, indexed_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())`,
          [market.marketId, market.tenantId, id<'Seller'>(), slug, name, settings.textSearchConfig],
        );
      await expect(bad('Not A Slug', 'Name')).rejects.toMatchObject({ code: CHECK });
      await expect(bad('ok-slug', '')).rejects.toMatchObject({ code: CHECK });
    });

    it('lists the scope of a text or a category with product, seller and category ids', async () => {
      const tea = id<'Category'>();
      const [sellerA, sellerB] = [id<'Seller'>(), id<'Seller'>()];
      const product = id<'Product'>();
      await seed(
        market,
        doc({ name: 'Green tea', productId: product, sellerId: sellerA, categoryIds: [tea] }),
        doc({ name: 'Green tea', productId: product, sellerId: sellerB, categoryIds: [tea] }),
        doc({ name: 'Coffee beans', sellerId: sellerA }),
      );
      const scope = (text: string | null, categoryIds: readonly Id<'Category'>[] | null) =>
        inUnit(
          market,
          () =>
            scopeReader.scopeRows(market, {
              textSearchConfig: settings.textSearchConfig,
              text,
              categoryIds,
            }),
          true,
        );

      const byText = await scope('tea', null);
      expect(byText.map((row) => [row.productId, row.sellerId]).sort()).toEqual(
        [
          [product, sellerA],
          [product, sellerB],
        ].sort(),
      );
      expect((await scope(null, [tea])).every((row) => row.categoryIds.includes(tea))).toBe(true);
      expect(await scope('coffee', [tea])).toEqual([]);
      await expect(scope(null, null)).rejects.toThrow('a count needs a text or a category');
    });
  });

  describe('culture codes (multi-culture package 3a; ADR-0047 decision 8)', () => {
    const certified = code === 'AU' ? 'muslim' : 'jewish';
    const cultureId = id<'Culture'>();
    const codesOf = async (offerId: Id<'Offer'>, on: MarketContext = market) => {
      const row = await sql.query<{ c: string[] }>(
        'SELECT culture_codes AS c FROM "search"."offer_documents" WHERE offer_id = $1 AND market_id = $2',
        [offerId, on.marketId],
      );
      return row.rows[0]?.c;
    };

    it('defaults to no culture, keeps what upsert writes, and refuses a null or oversized list', async () => {
      const plain = doc({ name: 'Plain tea' });
      const tagged = doc({ name: 'Tagged tea', cultureCodes: ['general', certified] });
      await seed(market, plain, tagged);
      expect(await codesOf(plain.offerId)).toEqual([]);
      expect(await codesOf(tagged.offerId)).toEqual(['general', certified]);

      await seed(market, { ...tagged, cultureCodes: [certified] });
      expect(await codesOf(tagged.offerId)).toEqual([certified]);

      const update = (value: unknown) =>
        sql.query(
          'UPDATE "search"."offer_documents" SET culture_codes = $1::text[] WHERE offer_id = $2',
          [value, plain.offerId],
        );
      await expect(update(['a', null])).rejects.toMatchObject({ code: CHECK });
      await expect(update(Array.from({ length: 201 }, (_, n) => `c${n}`))).rejects.toMatchObject({
        code: CHECK,
      });
      await expect(update(Array.from({ length: 200 }, (_, n) => `c${n}`))).resolves.toBeDefined();
    });

    it('has a GIN index on the codes', async () => {
      const row = await sql.query<{ d: string }>(
        `SELECT indexdef AS d FROM pg_indexes
          WHERE schemaname = 'search' AND indexname = 'offer_documents_culture_codes_idx'`,
      );
      expect(row.rows[0]?.d).toMatch(/USING gin \(culture_codes\)/);
    });

    it('pages the Offers that hold a code, in this Market only', async () => {
      const holders = [1, 2, 3].map(() => doc({ name: 'Holder', cultureCodes: [certified] }));
      await seed(market, ...holders, doc({ name: 'Other', cultureCodes: ['general'] }));
      await seed(other, doc({ name: 'Elsewhere', cultureCodes: [certified] }));
      const sorted = holders.map((h) => h.offerId).sort();

      const page = (after?: Id<'Offer'>) =>
        inUnit(market, () => documents.offerIdsWithCultureCode(market, certified, 2, after), true);
      expect(await page()).toEqual(sorted.slice(0, 2));
      expect(await page(sorted[1])).toEqual(sorted.slice(2));
      expect(await page(sorted[2])).toEqual([]);
    });

    it('re-indexes the codes through SyncOfferDocuments: by Offer and by culture', async () => {
      const sellerId = id<'Seller'>();
      const first = id<'Offer'>();
      const second = id<'Offer'>();
      const facts = (name: string): FeedFacts => ({
        sellerId,
        productId: id<'Product'>(),
        sellable: true,
        name,
        shortText: null,
        categoryIds: [],
        attributes: { searchText: '', facets: [], numbers: {} },
        variants: [],
      });
      const feedFacts = new Map([
        [first, facts('First tea')],
        [second, facts('Second tea')],
      ]);
      const visible = new Map<Id<'Offer'>, readonly string[]>([
        [first, ['general', certified]],
        [second, ['general']],
      ]);
      const deps: SearchDependencies = {
        unitOfWork: db.unitOfWork,
        documents,
        index: new PostgresOfferSearchIndex(
          reader,
          facetReader,
          new RawOfferScopeReader(new PrismaRawReadPort(db.root).forModule('search')),
          new RawStoreSearchReader(new PrismaRawReadPort(db.root).forModule('search')),
        ),
        storeDocuments: new PrismaStoreDocumentRepository(db.service),
        categoryTree: { tree: () => Promise.resolve([]) },
        cultures: {
          visibleCodes: (_context, offerIds) =>
            Promise.resolve(
              new Map(offerIds.flatMap((o) => (visible.has(o) ? [[o, visible.get(o)!]] : []))),
            ),
          codeOf: (_context, asked) => Promise.resolve(asked === cultureId ? certified : undefined),
        },
        storeDirectory: { publicStores: () => Promise.resolve(new Map()) },
        filterSource: { filters: () => Promise.resolve([]) },
        policy,
        feed: {
          facts: (_context, offerIds) =>
            Promise.resolve(
              new Map(offerIds.flatMap((o) => (feedFacts.has(o) ? [[o, feedFacts.get(o)!]] : []))),
            ),
          publishedIds: () => Promise.resolve([]),
        },
        visibility: { visible: () => Promise.resolve(new Set()) },
        sellers: { eligible: (_context, ids) => Promise.resolve(new Set(ids)) },
        clock: new FixedClock(T0),
        shelves,
        stores: { sellerIdOf: () => Promise.resolve({ sellerId: null }) },
        brands: { productIdsOf: () => Promise.resolve({ productIds: [], truncated: false }) },
        images: { of: () => Promise.resolve(new Map()) },
        categories: { subtreeOf: (_context, categoryId) => Promise.resolve([categoryId]) },
        sellUnits: { states: () => Promise.resolve(new Map()) },
        variants: new PrismaOfferVariantReader(db.service),
      };
      const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
      const system = testCallContext(market, 'system', 'search-db-culture-1');
      const sync = (input: Parameters<SyncOfferDocuments['execute']>[1]) =>
        new SyncOfferDocuments(gate, deps).execute(system, input);

      expect(await sync({ offerIds: [first, second] })).toEqual({
        ok: true,
        value: { upserted: 2, deleted: 0 },
      });
      expect(await codesOf(first)).toEqual(['general', certified]);
      expect(await codesOf(second)).toEqual(['general']);

      // The seller's certificate expired: catalog answers the plain culture only, and the
      // culture-scoped re-sync touches only the document that held the certified code.
      visible.set(first, ['general']);
      expect(await sync({ cultureId })).toEqual({ ok: true, value: { upserted: 1, deleted: 0 } });
      expect(await codesOf(first)).toEqual(['general']);

      // A tag added later: the Offer-scoped re-sync (the tag event's) writes the code back.
      visible.set(second, ['general', certified]);
      expect(await sync({ offerIds: [second] })).toEqual({
        ok: true,
        value: { upserted: 1, deleted: 0 },
      });
      expect(await codesOf(second)).toEqual(['general', certified]);
      expect(await codesOf(second, other)).toBeUndefined();
    });
  });
});
