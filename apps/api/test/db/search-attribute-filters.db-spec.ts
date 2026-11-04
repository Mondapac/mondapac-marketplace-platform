import { ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import type { FilteredSearchRequest } from '../../src/modules/search/application/ports/offer-facet.reader';
import { MAX_FACET_ROWS } from '../../src/modules/search/application/ports/offer-facet.reader';
import type { OfferDocument } from '../../src/modules/search/domain/offer-document';
import { ConfigSearchPolicy } from '../../src/modules/search/infrastructure/config-search-policy';
import { PrismaReindexProgress } from '../../src/modules/search/infrastructure/prisma-reindex-progress';
import { PrismaOfferDocumentRepository } from '../../src/modules/search/infrastructure/prisma-offer-document.repository';
import { RawOfferFacetReader } from '../../src/modules/search/infrastructure/raw-offer-facet.reader';
import { RawOfferSearchReader } from '../../src/modules/search/infrastructure/raw-offer-search.reader';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PrismaRawReadPort } from '../../src/platform/persistence/raw-reads/prisma-raw-read-port';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Attribute filters (search A7) on PostgreSQL, as the application role, for both Market fixtures:
// searchable attribute text in the vector (weight C), facet groups (OR inside a group, AND between
// groups), number ranges, the facet and number reads behind the counts, Market isolation and the
// replacement of a document's numbers.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-04T10:00:00Z');

let counter = 0;
const id = <T extends string>(): Id<T> => {
  counter += 1;
  const parsed = parseId(
    `01990000-0000-7000-8000-${(0xe0000 + counter).toString(16).padStart(12, '0')}`,
  );
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};

describe.each(TEST_MARKETS)('attribute filters in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const policy = new ConfigSearchPolicy(markets);
  const settings = policy.settings(market);
  const CATEGORY = id<'Category'>();
  let db: Persistence;
  let documents: PrismaOfferDocumentRepository;
  let reader: RawOfferSearchReader;
  let facets: RawOfferFacetReader;
  let sql: Client;

  const doc = (overrides: Partial<OfferDocument> & { name: string }): OfferDocument => ({
    offerId: id<'Offer'>(),
    productId: id<'Product'>(),
    sellerId: id<'Seller'>(),
    locale: settings.locale,
    shortText: null,
    categoryIds: [CATEGORY],
    textSearchConfig: settings.textSearchConfig,
    searchText: null,
    facetCodes: [],
    numbers: {},
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
  const request = (overrides: Partial<FilteredSearchRequest> = {}): FilteredSearchRequest => ({
    textSearchConfig: settings.textSearchConfig,
    text: null,
    categoryIds: [CATEGORY],
    limit: 49,
    offset: 0,
    choiceGroups: [],
    ranges: [],
    ...overrides,
  });
  const filtered = (overrides: Partial<FilteredSearchRequest> = {}, on = market) =>
    inUnit(on, () => facets.searchFiltered(on, request(overrides)), true);
  const names = (hits: readonly { name: string }[]) => hits.map((hit) => hit.name);

  // Four products: a halal small light one, a halal medium heavy one, a vegan small one, a plain one.
  const catalogue = () => [
    doc({
      name: 'Alpha',
      facetCodes: ['brand=al-safa', 'diet=halal', 'size=s'],
      numbers: { weight: 250 },
    }),
    doc({
      name: 'Bravo',
      facetCodes: ['brand=al-safa', 'diet=halal', 'size=m'],
      numbers: { weight: 1000.5 },
    }),
    doc({ name: 'Charlie', facetCodes: ['diet=vegan', 'size=s'], numbers: { weight: 500 } }),
    doc({ name: 'Delta', facetCodes: [] }),
  ];

  beforeAll(async () => {
    db = createPersistence();
    documents = new PrismaOfferDocumentRepository(db.service);
    const port = new PrismaRawReadPort(db.root).forModule('search');
    reader = new RawOfferSearchReader(port);
    facets = new RawOfferFacetReader(port);
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

  it('weighs searchable attribute text at C, below the name and short text', async () => {
    const byText = doc({ name: 'Plain tin', searchText: 'Al Safa Alsafa' });
    const byName = doc({ name: 'Safa dates' });
    await seed(market, byText, byName);

    const vector = await sql.query<{ v: string }>(
      'SELECT search_vector::text AS v FROM "search"."offer_documents" WHERE offer_id = $1 AND market_id = $2',
      [byText.offerId, market.marketId],
    );
    expect(vector.rows[0]?.v).toMatch(/'safa':\d+C/);

    const hits = await inUnit(
      market,
      () =>
        reader.search(market, {
          textSearchConfig: settings.textSearchConfig,
          text: 'safa',
          categoryIds: null,
          limit: 49,
          offset: 0,
        }),
      true,
    );
    // The name match outranks the attribute-text match; both are found.
    expect(names(hits)).toEqual(['Safa dates', 'Plain tin']);
  });

  it('lists a category browse by name when nothing is picked', async () => {
    await seed(market, ...catalogue());
    expect(names(await filtered())).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
  });

  it('ORs the values of one group and ANDs the groups', async () => {
    await seed(market, ...catalogue());
    expect(names(await filtered({ choiceGroups: [['diet=halal', 'diet=vegan']] }))).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
    ]);
    expect(
      names(await filtered({ choiceGroups: [['diet=halal', 'diet=vegan'], ['size=s']] })),
    ).toEqual(['Alpha', 'Charlie']);
    expect(
      names(await filtered({ choiceGroups: [['diet=halal'], ['size=s'], ['brand=al-safa']] })),
    ).toEqual(['Alpha']);
    expect(names(await filtered({ choiceGroups: [['diet=kosher']] }))).toEqual([]);
  });

  it('keeps documents whose number lies in the range, both ends included, and drops those without one', async () => {
    await seed(market, ...catalogue());
    expect(names(await filtered({ ranges: [{ attr: 'weight', min: '250', max: '500' }] }))).toEqual(
      ['Alpha', 'Charlie'],
    );
    expect(
      names(await filtered({ ranges: [{ attr: 'weight', min: '500.5', max: null }] })),
    ).toEqual(['Bravo']);
    expect(names(await filtered({ ranges: [{ attr: 'weight', min: null, max: '250' }] }))).toEqual([
      'Alpha',
    ]);
    // A number is compared as a number, not as text.
    expect(names(await filtered({ ranges: [{ attr: 'weight', min: '99', max: '100' }] }))).toEqual(
      [],
    );
  });

  it('combines a text query, a category, a group and a range', async () => {
    await seed(
      market,
      doc({ name: 'Beef sausages', facetCodes: ['diet=halal'], numbers: { weight: 400 } }),
      doc({ name: 'Beef mince', facetCodes: ['diet=halal'], numbers: { weight: 900 } }),
      doc({ name: 'Beef stock', facetCodes: ['diet=vegan'], numbers: { weight: 400 } }),
      doc({
        name: 'Beef elsewhere',
        categoryIds: [id<'Category'>()],
        facetCodes: ['diet=halal'],
        numbers: { weight: 400 },
      }),
    );
    const hits = await filtered({
      text: 'beef',
      choiceGroups: [['diet=halal']],
      ranges: [{ attr: 'weight', min: null, max: '500' }],
    });
    expect(names(hits)).toEqual(['Beef sausages']);
    // Without a category the same text query finds the other category too.
    const everywhere = await filtered({
      text: 'beef',
      categoryIds: null,
      choiceGroups: [['diet=halal']],
      ranges: [{ attr: 'weight', min: null, max: '500' }],
    });
    expect(names(everywhere).sort()).toEqual(['Beef elsewhere', 'Beef sausages']);
  });

  it('pages stably and treats a hostile facet value as plain data', async () => {
    await seed(market, ...catalogue());
    const first = await filtered({
      limit: 2,
      offset: 0,
      choiceGroups: [['diet=halal', 'diet=vegan']],
    });
    const second = await filtered({
      limit: 2,
      offset: 2,
      choiceGroups: [['diet=halal', 'diet=vegan']],
    });
    expect([...names(first), ...names(second)]).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(await filtered({ choiceGroups: [["x') OR 1=1 --", 'a=b;DROP TABLE x']] })).toEqual([]);
  });

  it('never reads another Market', async () => {
    await seed(other, ...catalogue());
    expect(await filtered({ choiceGroups: [['diet=halal']] })).toEqual([]);
    expect(await inUnit(market, () => facets.facetRows(market, request()), true)).toEqual([]);
    expect(
      await inUnit(market, () => facets.numberRows(market, request(), ['weight']), true),
    ).toEqual([]);
  });

  it('refuses what the reader cannot take: too many groups, no scope, an unknown rating mode', async () => {
    const nine = Array.from({ length: 9 }, (_, i) => [`a=${i}`]);
    await expect(filtered({ choiceGroups: nine })).rejects.toThrow(RangeError);
    await expect(filtered({ categoryIds: null, text: null })).rejects.toThrow(RangeError);
    await expect(filtered({ sort: 'top-rated' })).rejects.toThrow(RangeError);
  });

  it('reads the facet strings of a scope for counting, with its range filters applied', async () => {
    await seed(market, ...catalogue());
    const scope = {
      textSearchConfig: settings.textSearchConfig,
      text: null,
      categoryIds: [CATEGORY],
      ranges: [{ attr: 'weight', min: '250', max: '500' }],
    };
    const rows = await inUnit(market, () => facets.facetRows(market, scope), true);
    expect(rows.map((row) => [...row.facets].sort())).toEqual([
      ['brand=al-safa', 'diet=halal', 'size=s'],
      ['diet=vegan', 'size=s'],
    ]);
    expect(MAX_FACET_ROWS).toBe(20_000);
  });

  it('reads the stored numbers of some attributes over a scope', async () => {
    await seed(market, ...catalogue());
    const rows = await inUnit(
      market,
      () =>
        facets.numberRows(
          market,
          { ...request(), textSearchConfig: settings.textSearchConfig, text: null, ranges: [] },
          ['weight', 'cups'],
        ),
      true,
    );
    expect(rows.map((row) => Number(row.value)).sort((a, b) => a - b)).toEqual([250, 500, 1000.5]);
    expect(new Set(rows.map((row) => row.attr))).toEqual(new Set(['weight']));
  });

  it("replaces a document's numbers as a set and deletes them with the document", async () => {
    const d = doc({ name: 'Echo', numbers: { weight: 10, cups: 2 } });
    await seed(market, d);
    const count = async () =>
      Number(
        (
          await sql.query<{ n: string }>(
            'SELECT count(*) AS n FROM "search"."offer_document_numbers" WHERE offer_id = $1',
            [d.offerId],
          )
        ).rows[0]?.n,
      );
    expect(await count()).toBe(2);
    await seed(market, { ...d, numbers: { weight: 11 } });
    expect(await count()).toBe(1);
    await seed(market, { ...d, numbers: {} });
    expect(await count()).toBe(0);
    await seed(market, { ...d, numbers: { weight: 12 } });
    await inUnit(market, () => documents.deleteMany(market, [d.offerId]));
    expect(await count()).toBe(0);
  });

  it('keeps the table checks: at most 100 facet codes, no empty search text, a well-formed attribute code', async () => {
    const insertNumber = (attr: string) =>
      sql.query(
        `INSERT INTO "search"."offer_document_numbers" (market_id, tenant_id, offer_id, attr, value)
         SELECT market_id, tenant_id, offer_id, $1, 1 FROM "search"."offer_documents" LIMIT 1`,
        [attr],
      );
    await seed(market, doc({ name: 'Foxtrot' }));
    await expect(insertNumber('Weight')).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql.query(`UPDATE "search"."offer_documents" SET search_text = ''`),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      seed(
        market,
        doc({ name: 'Golf', facetCodes: Array.from({ length: 101 }, (_, i) => `a=${i}`) }),
      ),
    ).rejects.toThrow();
  });

  it('keeps one progress row per Market through a reindex: begin, pages, failure, resume, finish', async () => {
    const progress = new PrismaReindexProgress(db.service);
    const first = id<'Offer'>();
    const second = id<'Offer'>();

    expect(await inUnit(market, () => progress.read(market), true)).toBeNull();

    await inUnit(market, () => progress.begin(market, `${code}-1`, T0));
    await inUnit(market, () => progress.advance(market, 200, first, T0));
    await inUnit(market, () => progress.fail(market, 'sync-failed', T0));
    expect(await inUnit(market, () => progress.read(market), true)).toEqual({
      doneStamp: null,
      targetStamp: `${code}-1`,
      status: 'failed',
      offersDone: 200,
      cursorOfferId: first,
    });

    await inUnit(market, () => progress.advance(market, 250, second, T0));
    await inUnit(market, () => progress.finish(market, `${code}-1`, T0));
    expect(await inUnit(market, () => progress.read(market), true)).toEqual({
      doneStamp: `${code}-1`,
      targetStamp: `${code}-1`,
      status: 'idle',
      offersDone: 250,
      cursorOfferId: null,
    });

    // A new stamp begins again but keeps the stamp last done until it finishes.
    await inUnit(market, () => progress.begin(market, `${code}-2`, T0));
    expect(await inUnit(market, () => progress.read(market), true)).toMatchObject({
      doneStamp: `${code}-1`,
      targetStamp: `${code}-2`,
      status: 'running',
      offersDone: 0,
    });
    // Another Market's row (left by its own run) is never this Market's.
    const theirs = await inUnit(other, () => progress.read(other), true);
    expect(theirs?.targetStamp ?? '').not.toContain(`${code}-`);
    await expect(
      sql.query(`UPDATE "search"."reindex_state" SET status = 'paused'`),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
