import { ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { SearchDependencies } from '../../src/modules/search/application/search-dependencies';
import { SearchProducts } from '../../src/modules/search/application/use-cases/search-products.use-case';
import type { OfferDocument } from '../../src/modules/search/domain/offer-document';
import { ConfigSearchPolicy } from '../../src/modules/search/infrastructure/config-search-policy';
import { PrismaOfferDocumentRepository } from '../../src/modules/search/infrastructure/prisma-offer-document.repository';
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
import { testDatabaseUrl } from './test-database';

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
  let sql: Client;

  const doc = (overrides: Partial<OfferDocument> & { name: string }): OfferDocument => ({
    offerId: id<'Offer'>(),
    productId: id<'Product'>(),
    sellerId: id<'Seller'>(),
    locale: settings.locale,
    shortText: null,
    categoryIds: [],
    textSearchConfig: settings.textSearchConfig,
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
      categoryId?: Id<'Category'>;
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
          categoryId: options.categoryId ?? null,
          limit: options.limit ?? 49,
          offset: options.offset ?? 0,
        }),
      true,
    );
  const names = (hits: readonly { name: string }[]) => hits.map((hit) => hit.name);

  beforeAll(async () => {
    db = createPersistence();
    documents = new PrismaOfferDocumentRepository(db.service);
    reader = new RawOfferSearchReader(new PrismaRawReadPort(db.root).forModule('search'));
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });
  beforeEach(async () => {
    await sql.query('DELETE FROM "search"."offer_documents"');
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

    expect(names(await find('tea', { categoryId: tea }))).toHaveLength(2);
    expect(names(await find('tea', { categoryId: coffee }))).toEqual(['Apple tea']);
    expect(names(await find(null, { categoryId: tea }))).toEqual(['Apple tea', 'Zebra tea']);
    expect(names(await find(null, { categoryId: coffee }))).toEqual(['Apple tea', 'Mocha']);
    expect(await find(null, { categoryId: id<'Category'>() })).toEqual([]);
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
    expect(await find(null, { categoryId: mine.categoryIds[0] ?? id<'Category'>() })).toEqual([]);
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
        categoryId: null,
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
      reader,
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
    };
    const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
    const visitor = testCallContext(market, 'anonymous', 'search-db-visitor-1');

    const result = await new SearchProducts(gate, deps).execute(visitor, { q: 'mug', pageSize: 5 });

    expect(result.ok && result.value.items.map((item) => item.name)).toEqual(['Visible mug']);
    expect(result.ok && result.value.hasMore).toBe(false);
  });
});
