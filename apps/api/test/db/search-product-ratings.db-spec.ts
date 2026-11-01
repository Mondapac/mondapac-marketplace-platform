import { ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaOfferDocumentRepository } from '../../src/modules/search/infrastructure/prisma-offer-document.repository';
import { PrismaProductRatingRepository } from '../../src/modules/search/infrastructure/prisma-product-rating.repository';
import { RawOfferSearchReader } from '../../src/modules/search/infrastructure/raw-offer-search.reader';
import { ConfigSearchPolicy } from '../../src/modules/search/infrastructure/config-search-policy';
import type { OfferDocument } from '../../src/modules/search/domain/offer-document';
import {
  bayesTimes1000,
  boostPpm,
  type RatingBoostSettings,
} from '../../src/modules/search/domain/rating-boost';
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

// The three rated search statements (ADR-0030) on PostgreSQL in both Market fixtures: the stored
// rating factor moves relevance by at most the Market weight, "Top rated" orders by the stored
// Bayesian average, a product with no rating row is neutral, a rating row of another Market never
// counts, hostile text stays data, and the table's CHECKs refuse a boost outside 10 %. Every row
// is synthetic mock data made here.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-15T10:00:00Z');
const CHECK = '23514';

let counter = 0;
const id = <T extends string>(): Id<T> => {
  counter += 1;
  const parsed = parseId(
    `01990000-0000-7000-8000-${(0xe0000 + counter).toString(16).padStart(12, '0')}`,
  );
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};

describe.each(TEST_MARKETS)('rated search statements in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const settings = new ConfigSearchPolicy(markets).settings(market);
  // The AU file switches the boost off; the tests set the same numbers the ZZ fixture has on.
  const boost: RatingBoostSettings = settings.ratingBoost ?? {
    weightBps: 1000,
    priorCount: 10,
    priorMeanTimes100: 400,
  };
  let db: Persistence;
  let documents: PrismaOfferDocumentRepository;
  let ratings: PrismaProductRatingRepository;
  let reader: RawOfferSearchReader;
  let sql: Client;

  const doc = (name: string, productId: Id<'Product'> = id<'Product'>()): OfferDocument => ({
    offerId: id<'Offer'>(),
    productId,
    sellerId: id<'Seller'>(),
    locale: settings.locale,
    name,
    shortText: null,
    categoryIds: [],
    textSearchConfig: settings.textSearchConfig,
  });
  const inUnit = async <T>(target: MarketContext, work: () => Promise<T>, readOnly = false) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()), { readOnly });
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const rate = (target: MarketContext, productId: Id<'Product'>, count: number, sum: number) =>
    inUnit(target, () =>
      ratings.upsertMany(
        target,
        [
          {
            productId,
            count,
            sum,
            bayesTimes1000: bayesTimes1000(count, sum, boost),
            boostPpm: boostPpm(bayesTimes1000(count, sum, boost), boost),
          },
        ],
        T0,
      ),
    );
  const find = (text: string | null, sort?: 'top-rated', categoryIds?: Id<'Category'>[]) =>
    inUnit(
      market,
      () =>
        reader.search(market, {
          textSearchConfig: settings.textSearchConfig,
          text,
          categoryIds: categoryIds ?? null,
          limit: 49,
          offset: 0,
          ratingBoost: boost,
          ...(sort === undefined ? {} : { sort }),
        }),
      true,
    );

  beforeAll(async () => {
    db = createPersistence();
    documents = new PrismaOfferDocumentRepository(db.service);
    ratings = new PrismaProductRatingRepository(db.service);
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
    await sql.query('DELETE FROM "search"."product_ratings"');
  });
  const seed = (target: MarketContext, ...docs: OfferDocument[]) =>
    inUnit(target, async () => {
      for (const d of docs) await documents.upsert(target, d, T0);
    });

  it('breaks a relevance tie by stars, and a rating never lifts a worse text match far', async () => {
    const good = doc('Mock olive oil');
    const poor = doc('Mock olive oil');
    await seed(market, good, poor);
    await rate(market, good.productId, 40, 190);
    await rate(market, poor.productId, 40, 60);
    const hits = await find('olive');
    expect(hits.map((h) => h.offerId)).toEqual([good.offerId, poor.offerId]);
    // The factor stays inside the Market weight.
    const stored = await sql.query<{ boost_ppm: number }>(
      'SELECT boost_ppm FROM "search"."product_ratings" WHERE market_id = $1 ORDER BY boost_ppm DESC',
      [market.marketId],
    );
    const top = stored.rows[0]!.boost_ppm;
    expect(top).toBeLessThanOrEqual(1_000_000 + boost.weightBps * 100);
    expect(top).toBeLessThanOrEqual(1_100_000);
  });

  it('keeps an unrated product neutral: a name match beats a mid rating on a weaker match', async () => {
    const inName = doc('Mock dates');
    const inShort: OfferDocument = { ...doc('Fruit box'), shortText: 'Mock dates' };
    await seed(market, inShort, inName);
    await rate(market, inShort.productId, 50, 250);
    const hits = await find('dates');
    expect(hits.map((h) => h.offerId)).toEqual([inName.offerId, inShort.offerId]);
  });

  it('orders Top rated by the stored Bayesian average, and one five-star review does not win', async () => {
    const category = id<'Category'>();
    const inCategory = (d: OfferDocument): OfferDocument => ({ ...d, categoryIds: [category] });
    const five = inCategory(doc('Mock rice'));
    const four = inCategory(doc('Mock rice'));
    const none = inCategory(doc('Mock rice'));
    const lonely = inCategory(doc('Mock rice'));
    await seed(market, none, four, lonely, five);
    await rate(market, five.productId, 200, 940);
    await rate(market, four.productId, 20, 80);
    await rate(market, lonely.productId, 1, 5);
    const hits = await find('rice', 'top-rated');
    // One five-star review is not better than 200 good ones.
    expect(hits[0]!.offerId).toBe(five.offerId);
    expect(hits.slice(-1)[0]!.offerId).not.toBe(five.offerId);
    expect(hits).toHaveLength(4);
    const browse = await find(null, 'top-rated', [category]);
    expect(browse.map((h) => h.offerId)).toContain(none.offerId);
    expect(browse[0]!.offerId).toBe(five.offerId);
  });

  it('ignores a rating row of another Market', async () => {
    const a = doc('Mock tea');
    const b = doc('Mock tea');
    await seed(market, a, b);
    await seed(other, { ...doc('Mock tea'), productId: a.productId });
    await rate(other, a.productId, 100, 500);
    await rate(market, b.productId, 100, 480);
    const hits = await find('tea', 'top-rated');
    expect(hits[0]!.offerId).toBe(b.offerId);
  });

  it('never lets a late sync run overwrite a fresher one', async () => {
    const productId = id<'Product'>();
    const write = (count: number, sum: number, at: Temporal.Instant) =>
      inUnit(market, () =>
        ratings.upsertMany(
          market,
          [
            {
              productId,
              count,
              sum,
              bayesTimes1000: bayesTimes1000(count, sum, boost),
              boostPpm: boostPpm(bayesTimes1000(count, sum, boost), boost),
            },
          ],
          at,
        ),
      );
    await write(10, 40, T0.add({ hours: 1 }));
    await write(2, 4, T0);
    const row = await sql.query<{ rating_count: number }>(
      'SELECT rating_count FROM "search"."product_ratings" WHERE market_id = $1 AND product_id = $2',
      [market.marketId, productId],
    );
    expect(row.rows).toEqual([{ rating_count: 10 }]);
    await write(11, 44, T0.add({ hours: 2 }));
    const newer = await sql.query<{ rating_count: number }>(
      'SELECT rating_count FROM "search"."product_ratings" WHERE product_id = $1',
      [productId],
    );
    expect(newer.rows).toEqual([{ rating_count: 11 }]);
  });

  it('treats hostile query text as data', async () => {
    await seed(market, doc('Mock honey'));
    for (const text of ["'; DROP TABLE search.product_ratings; --", '(((', '& | !', '\\']) {
      await expect(find(text)).resolves.toBeDefined();
      await expect(find(text, 'top-rated')).resolves.toBeDefined();
    }
    const left = await sql.query('SELECT 1 FROM "search"."product_ratings" LIMIT 1');
    expect(left.rows).toBeDefined();
  });

  it('refuses stored values outside the CHECKs (a boost beyond 10 %, a count of zero)', async () => {
    const insert = (over: Partial<Record<string, number>>) => {
      const v = { count: 3, sum: 12, bayes: 4000, boost: 1_000_000, ...over };
      return sql.query(
        `INSERT INTO "search"."product_ratings"
           (market_id, tenant_id, product_id, rating_count, rating_sum, bayes_times_1000, boost_ppm, synced_at)
         VALUES ($1, 'default', $2, $3, $4, $5, $6, now())`,
        [market.marketId, id<'Product'>(), v.count, v.sum, v.bayes, v.boost],
      );
    };
    await expect(insert({})).resolves.toBeDefined();
    await expect(insert({ boost: 1_100_001 })).rejects.toMatchObject({ code: CHECK });
    await expect(insert({ boost: 899_999 })).rejects.toMatchObject({ code: CHECK });
    await expect(insert({ count: 0, sum: 0 })).rejects.toMatchObject({ code: CHECK });
    await expect(insert({ sum: 16 })).rejects.toMatchObject({ code: CHECK });
    await expect(insert({ bayes: 5001 })).rejects.toMatchObject({ code: CHECK });
  });
});
