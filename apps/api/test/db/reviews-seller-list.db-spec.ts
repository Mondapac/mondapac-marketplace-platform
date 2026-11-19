import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import {
  compareSellerReviews,
  EMPTY_SELLER_REVIEW_FILTER,
  SELLER_REVIEW_VIEWS,
  sellerReviewMatches,
  sellerReviewViewFilter,
  type SellerReviewFilter,
  type SellerReviewSort,
  type SellerReviewSubject,
} from '../../src/modules/reviews/domain/seller-review-list';
import { PrismaReviewRepository } from '../../src/modules/reviews/infrastructure/prisma-review.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The shop's review list on PostgreSQL (super list 32), for both Market fixtures: the repository's
// filters, sorts, counts, id lookups and page windows against the in-memory twin
// (`sellerReviewMatches`, `compareSellerReviews`) that the unit specs use. Published reviews of
// the shop with and without a published reply, held and hidden ones, another shop's, and a
// review of the same shop in the other Market.

describe.each(TEST_MARKETS)('seller review list in market %s (database)', (code) => {
  const market = marketOf(code);
  const foreign = marketOf(otherMarketOf(code));
  const clock = new FixedClock(Temporal.Instant.from('2026-11-01T10:00:00Z'));
  const ids = new UuidV7IdGenerator(clock);
  const seller = ids.next<'Seller'>();
  const otherSeller = ids.next<'Seller'>();
  const buyer = ids.next<'Account'>();
  const T0 = Temporal.Instant.from('2026-10-01T00:00:00Z');

  let db: Persistence;
  let owner: Client;
  let repository: PrismaReviewRepository;
  const subjects: SellerReviewSubject[] = [];

  const insert = async (
    market_: typeof market,
    sellerId: Id<'Seller'>,
    extra: {
      rating: number;
      title: string | null;
      body: string | null;
      day: number;
      status?: string;
      reply?: 'published' | 'hidden' | 'superseded' | null;
    },
  ) => {
    const id = ids.next<'ProductReview'>();
    const productId = ids.next<'Product'>();
    const offerId = ids.next<'Offer'>();
    const orderRef = ids.next<'SellerOrder'>();
    const publishedAt = T0.add({ hours: 24 * extra.day });
    await owner.query(
      `INSERT INTO reviews.product_reviews
         (id, market_id, tenant_id, account_id, product_id, offer_id, seller_id, last_seller_order_id,
          rating, title, body, locale, anonymous, status, created_at, published_at, last_purchase_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'en', false, $12, now(), $13, now())`,
      [
        id,
        market_.marketId,
        market_.tenantId,
        buyer,
        productId,
        offerId,
        sellerId,
        orderRef,
        extra.rating,
        extra.title,
        extra.body,
        extra.status ?? 'published',
        publishedAt.toString(),
      ],
    );
    if (extra.reply !== undefined && extra.reply !== null) {
      await owner.query(
        `INSERT INTO reviews.review_replies (id, market_id, tenant_id, review_id, seller_id, body, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'Thanks', $6, now())`,
        [ids.next<'ReviewReply'>(), market_.marketId, market_.tenantId, id, sellerId, extra.reply],
      );
    }
    return { id, productId, offerId, orderRef, publishedAt };
  };

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    repository = new PrismaReviewRepository(db.service);
    const plan = [
      { rating: 1, title: 'Late parcel', body: 'Took weeks', day: 1, reply: null },
      { rating: 2, title: 'Meh 100%_off', body: null, day: 2, reply: 'published' as const },
      { rating: 3, title: null, body: 'Fine, as described', day: 3, reply: null },
      { rating: 4, title: 'Good', body: 'Quick and LOVELY', day: 3, reply: 'hidden' as const },
      { rating: 5, title: 'Great', body: 'Would buy again', day: 5, reply: 'published' as const },
      { rating: 5, title: 'Great too', body: 'Same day', day: 5, reply: 'superseded' as const },
      { rating: 2, title: 'Another late one', body: 'Late again', day: 6, reply: null },
      // Only an unescaped `%` or `_` would match the search for `100%_off`.
      { rating: 3, title: '100xyoff', body: null, day: 6, reply: null },
    ];
    for (const row of plan) {
      const made = await insert(market, seller, row);
      subjects.push({
        id: made.id,
        productId: made.productId,
        offerId: made.offerId,
        orderRef: made.orderRef,
        rating: row.rating,
        title: row.title,
        body: row.body,
        publishedAt: made.publishedAt,
        hasReply: row.reply === 'published',
      });
    }
    // Never listed: held, hidden, another shop's, and the same shop in the other Market.
    await insert(market, seller, { rating: 1, title: 'Held', body: 'x', day: 1, status: 'held' });
    await insert(market, seller, { rating: 1, title: 'Hid', body: 'x', day: 1, status: 'hidden' });
    await insert(market, otherSeller, { rating: 1, title: 'Late theirs', body: 'x', day: 1 });
    await insert(foreign, seller, { rating: 1, title: 'Late elsewhere', body: 'x', day: 1 });
  });
  afterAll(async () => {
    await db.close();
    await owner.end();
  });

  const rows = async (text: string, values: unknown[]) =>
    (await owner.query(text, values)).rows as Record<string, unknown>[];

  const read = (filter: SellerReviewFilter, sort: SellerReviewSort, offset = 0, limit = 50) =>
    db.unitOfWork.run(
      market,
      async () => ({
        ok: true as const,
        value: await repository.querySellerReviews(market, seller, filter, sort, offset, limit),
      }),
      { readOnly: true },
    );

  const FILTERS: readonly [string, Partial<SellerReviewFilter>][] = [
    ['none', {}],
    ['unanswered', { reply: 'none' }],
    ['answered', { reply: 'published' }],
    ['low', { maxRating: 2 }],
    ['stars 3 to 4', { minRating: 3, maxRating: 4 }],
    ['text, case-insensitive', { text: 'late' }],
    ['text with a wildcard character', { text: '100%_off' }],
    ['text none', { text: 'no such thing' }],
    ['from', { from: T0.add({ hours: 24 * 3 }) }],
    ['to', { to: T0.add({ hours: 24 * 3 }) }],
    ['unanswered low late', { reply: 'none', maxRating: 2, text: 'late' }],
  ];
  const SORTS: readonly SellerReviewSort[] = [
    { key: 'published', direction: 'desc' },
    { key: 'published', direction: 'asc' },
    { key: 'rating', direction: 'desc' },
    { key: 'rating', direction: 'asc' },
  ];

  it.each(FILTERS)('matches the in-memory twin: %s', async (_name, partial) => {
    const filter = { ...EMPTY_SELLER_REVIEW_FILTER, ...partial };
    for (const sort of SORTS) {
      const expected = subjects
        .filter((s) => sellerReviewMatches(s, filter))
        .sort((a, b) => compareSellerReviews(a, b, sort))
        .map((s) => s.id);
      const got = await read(filter, sort);
      expect(got.ok && got.value.map((row) => row.review.id)).toEqual(expected);
      const count = await db.unitOfWork.run(
        market,
        async () => ({
          ok: true as const,
          value: await repository.countSellerReviewsWhere(market, seller, filter),
        }),
        { readOnly: true },
      );
      expect(count.ok && count.value).toBe(expected.length);
    }
  });

  it('matches an exact id of the review, its order, its Offer or its product', async () => {
    const target = subjects[2]!;
    for (const anyId of [target.id, target.orderRef!, target.offerId, target.productId]) {
      const got = await read({ ...EMPTY_SELLER_REVIEW_FILTER, anyId }, SORTS[0]!);
      expect(got.ok && got.value.map((row) => row.review.id)).toEqual([target.id]);
    }
  });

  it('pages without repeating or skipping a row, even on equal stars and days', async () => {
    const sort: SellerReviewSort = { key: 'rating', direction: 'desc' };
    const seen: string[] = [];
    for (let offset = 0; offset < subjects.length; offset += 2) {
      const page = await read(EMPTY_SELLER_REVIEW_FILTER, sort, offset, 2);
      if (page.ok) seen.push(...page.value.map((row) => row.review.id));
    }
    const all = await read(EMPTY_SELLER_REVIEW_FILTER, sort);
    expect(seen).toEqual(all.ok ? all.value.map((row) => row.review.id) : null);
    expect(new Set(seen).size).toBe(subjects.length);
  });

  it('counts each view for the shop, and the reply it shows is the shop’s published one', async () => {
    const counts = await db.unitOfWork.run(
      market,
      async () => ({
        ok: true as const,
        value: await repository.sellerReviewViewCounts(market, seller),
      }),
      { readOnly: true },
    );
    const expected = Object.fromEntries(
      SELLER_REVIEW_VIEWS.map((view) => [
        view,
        subjects.filter((s) =>
          sellerReviewMatches(s, {
            ...EMPTY_SELLER_REVIEW_FILTER,
            ...sellerReviewViewFilter(view),
          }),
        ).length,
      ]),
    );
    expect(counts.ok && counts.value).toEqual(expected);
    const answered = await read({ ...EMPTY_SELLER_REVIEW_FILTER, reply: 'published' }, SORTS[0]!);
    expect(answered.ok && answered.value.every((row) => row.reply?.status === 'published')).toBe(
      true,
    );
  });

  it('finds only the shop’s published reviews among the ids asked', async () => {
    const mineIds = subjects.slice(0, 3).map((s) => s.id);
    const [other] = (
      await rows(
        `SELECT id FROM reviews.product_reviews WHERE seller_id <> $1 AND market_id = $2 LIMIT 1`,
        [seller, market.marketId],
      )
    ).map((row) => row.id as Id<'ProductReview'>);
    const [held] = (
      await rows(
        `SELECT id FROM reviews.product_reviews WHERE seller_id = $1 AND status = 'held' AND market_id = $2`,
        [seller, market.marketId],
      )
    ).map((row) => row.id as Id<'ProductReview'>);
    const found = await db.unitOfWork.run(
      market,
      async () => ({
        ok: true as const,
        value: await repository.findSellerReviewsByIds(market, seller, [...mineIds, other!, held!]),
      }),
      { readOnly: true },
    );
    expect(found.ok && found.value.map((row) => row.review.id).sort()).toEqual([...mineIds].sort());
  });
});
