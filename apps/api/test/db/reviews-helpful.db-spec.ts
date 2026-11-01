import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { CastHelpfulVote } from '../../src/modules/reviews/application/use-cases/cast-helpful-vote.use-case';
import { DetachAuthor } from '../../src/modules/reviews/application/use-cases/detach-author.use-case';
import { ListProductRatingTotals } from '../../src/modules/reviews/application/use-cases/list-product-rating-totals.use-case';
import { ListProductReviews } from '../../src/modules/reviews/application/use-cases/list-product-reviews.use-case';
import { RebuildRatingSummaries } from '../../src/modules/reviews/application/use-cases/rebuild-rating-summaries.use-case';
import { RemoveHelpfulVote } from '../../src/modules/reviews/application/use-cases/remove-helpful-vote.use-case';
import { SetReviewsStatus } from '../../src/modules/reviews/application/use-cases/set-reviews-status.use-case';
import type { ReviewsDependencies } from '../../src/modules/reviews/application/reviews-dependencies';
import { ConfigReviewsPolicy } from '../../src/modules/reviews/infrastructure/config-reviews-policy';
import { PrismaMarketSettingRepository } from '../../src/modules/reviews/infrastructure/prisma-market-setting.repository';
import { PrismaReviewRepository } from '../../src/modules/reviews/infrastructure/prisma-review.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import {
  FakeAffinity,
  FakeDeliveries,
  FakeNames,
  FakeOffers,
  FakeOverlap,
  FakeStepUp,
} from '../support/reviews-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Package 5 on the real tables, in both Market fixtures: helpful votes (the triggers that keep the
// count exact, the daily limit rolling a vote back, the keyset order of `sort=helpful`, the
// detach of a deleted account) and the per-product totals the search module copies. All rows are
// synthetic mock data made here; nothing is seeded into a shared database.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const NO_PRIVILEGE = '42501';

describe.each(TEST_MARKETS)('reviews package 5 in market %s (database)', (code) => {
  const market = marketOf(code);
  const limit = markets.get(market.marketId).reviews!.maxHelpfulVotesPerAccountPerDay;
  const clock = new FixedClock(Temporal.Instant.from('2020-03-02T10:00:00Z'));
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const system = testCallContext(market, 'system', 'reviews-p5-system-1');
  const anonymous = testCallContext(market, 'anonymous', 'reviews-p5-anon-1');
  const admin = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: ids.next<'Account'>(),
      sessionId: ids.next<'Session'>(),
      sellerId: null,
    }),
    'reviews-p5-admin-1',
  );
  const customer = (accountId: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
      'reviews-p5-customer-1',
    );

  let db: Persistence;
  let sql: Client;
  let owner: Client;
  let deps: ReviewsDependencies;
  let affinity: FakeAffinity;

  beforeAll(async () => {
    db = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
    affinity = new FakeAffinity();
    clock.set(Temporal.Instant.from(new Date().toISOString()));
    deps = {
      unitOfWork: db.unitOfWork,
      reviews: new PrismaReviewRepository(db.service),
      settings: new PrismaMarketSettingRepository(db.service),
      policy: new ConfigReviewsPolicy(markets),
      ordering: new FakeDeliveries().facade(),
      catalog: new FakeOffers().facade(),
      names: new FakeNames(),
      affinity,
      overlap: new FakeOverlap(),
      stepUp: new FakeStepUp(),
      audit: { record: () => Promise.resolve() },
      ids,
      clock,
    };
    const on = await new SetReviewsStatus(gate, deps).execute(admin, { status: 'active' });
    expect(on.ok).toBe(true);
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
    await owner.end();
  });

  const rows = async (text: string, values: unknown[] = []) =>
    (await owner.query(text, values)).rows as Record<string, unknown>[];

  /** A published review made straight in the table (mock data), returning its two ids. */
  async function publish(
    over: { productId?: Id<'Product'>; accountId?: Id<'Account'> | null; rating?: number } = {},
    publishedAt = new Date(),
  ): Promise<{ id: string; publicId: string; productId: Id<'Product'>; sellerId: Id<'Seller'> }> {
    const productId = over.productId ?? ids.next<'Product'>();
    const sellerId = ids.next<'Seller'>();
    const accountId = over.accountId === undefined ? ids.next<'Account'>() : over.accountId;
    const inserted = await rows(
      `INSERT INTO reviews.product_reviews
         (id, market_id, tenant_id, account_id, product_id, offer_id, seller_id, last_seller_order_id,
          rating, title, body, locale, anonymous, status, created_at, published_at, last_purchase_at)
       VALUES ($1, $2, 'default', $3, $4, $5, $6, $7, $8, 'Mock', 'Mock review text', 'en', false,
               'published', $9, $9, $9)
       RETURNING id, public_id`,
      [
        ids.next<'ProductReview'>(),
        market.marketId,
        accountId,
        productId,
        ids.next<'Offer'>(),
        sellerId,
        ids.next<'SellerOrder'>(),
        over.rating ?? 5,
        publishedAt,
      ],
    );
    return {
      id: inserted[0]!.id as string,
      publicId: inserted[0]!.public_id as string,
      productId,
      sellerId,
    };
  }
  const countOf = async (id: string) =>
    Number(
      (await rows('SELECT helpful_count FROM reviews.product_reviews WHERE id = $1', [id]))[0]!
        .helpful_count,
    );
  const vote = (accountId: Id<'Account'>, publicId: string) =>
    new CastHelpfulVote(gate, deps).execute(customer(accountId), { reviewId: publicId });
  const unvote = (accountId: Id<'Account'>, publicId: string) =>
    new RemoveHelpfulVote(gate, deps).execute(customer(accountId), { reviewId: publicId });

  it('keeps the count exact through votes and take-backs, and answers a repeat as it is', async () => {
    const review = await publish();
    const a = ids.next<'Account'>();
    const b = ids.next<'Account'>();
    expect(await vote(a, review.publicId)).toMatchObject({
      ok: true,
      value: { helpfulCount: 1, voted: true },
    });
    expect(await vote(a, review.publicId)).toMatchObject({ ok: true, value: { helpfulCount: 1 } });
    expect(await vote(b, review.publicId)).toMatchObject({ ok: true, value: { helpfulCount: 2 } });
    expect(await countOf(review.id)).toBe(2);
    expect(await unvote(a, review.publicId)).toMatchObject({
      ok: true,
      value: { helpfulCount: 1, voted: false },
    });
    expect(await unvote(a, review.publicId)).toMatchObject({
      ok: true,
      value: { helpfulCount: 1 },
    });
    expect(await countOf(review.id)).toBe(1);
    const real = await rows(
      'SELECT count(*)::int AS n FROM reviews.helpful_votes WHERE review_id = $1',
      [review.id],
    );
    expect(real[0]!.n).toBe(1);
  });

  it('refuses a vote on the voter’s own review and by a member of the seller’s team', async () => {
    const author = ids.next<'Account'>();
    const own = await publish({ accountId: author });
    expect(await vote(author, own.publicId)).toMatchObject({
      ok: false,
      error: { code: 'reviews.own-review' },
    });
    const staff = ids.next<'Account'>();
    affinity.tied.add(`${staff}:${own.sellerId}`);
    expect(await vote(staff, own.publicId)).toMatchObject({ ok: false });
    expect(await countOf(own.id)).toBe(0);
  });

  it('rolls a vote back when it is over the daily limit, and still answers a repeat at the limit', async () => {
    const voter = ids.next<'Account'>();
    const reviews = [];
    for (let i = 0; i < limit + 1; i += 1) reviews.push(await publish());
    for (let i = 0; i < limit; i += 1) {
      expect((await vote(voter, reviews[i]!.publicId)).ok).toBe(true);
    }
    expect(await vote(voter, reviews[limit]!.publicId)).toMatchObject({
      ok: false,
      error: { code: 'reviews.rate-limited' },
    });
    expect(await countOf(reviews[limit]!.id)).toBe(0);
    expect(await vote(voter, reviews[0]!.publicId)).toMatchObject({ ok: true });
    const mine = await rows(
      'SELECT count(*)::int AS n FROM reviews.helpful_votes WHERE account_id = $1',
      [voter],
    );
    expect(mine[0]!.n).toBe(limit);
  });

  it('lets the application role write only what the grants name', async () => {
    const review = await publish();
    const voter = ids.next<'Account'>();
    const insert = (marketId: string) =>
      sql.query(
        `INSERT INTO reviews.helpful_votes (market_id, tenant_id, review_id, account_id, created_at)
         VALUES ($1, 'default', $2, $3, now())`,
        [marketId, review.id, voter],
      );
    await insert(market.marketId);
    expect(await countOf(review.id)).toBe(1);
    // A vote is never updated, and the count is not set by hand to a value the votes do not hold.
    await expect(
      sql.query('UPDATE reviews.helpful_votes SET created_at = now() WHERE review_id = $1', [
        review.id,
      ]),
    ).rejects.toMatchObject({ code: NO_PRIVILEGE });
    await expect(
      sql.query('UPDATE reviews.product_reviews SET product_id = product_id WHERE id = $1', [
        review.id,
      ]),
    ).rejects.toMatchObject({ code: NO_PRIVILEGE });
    await expect(
      sql.query('UPDATE reviews.product_reviews SET helpful_count = -1 WHERE id = $1', [review.id]),
    ).rejects.toMatchObject({ code: '42501' });
    // The count is derived: a plausible value written by hand, or a review born with one, is refused.
    await expect(
      sql.query('UPDATE reviews.product_reviews SET helpful_count = 5 WHERE id = $1', [review.id]),
    ).rejects.toMatchObject({ code: NO_PRIVILEGE });
    await expect(
      owner.query('UPDATE reviews.product_reviews SET helpful_count = 5 WHERE id = $1', [
        review.id,
      ]),
    ).rejects.toMatchObject({ code: NO_PRIVILEGE });
    expect(await countOf(review.id)).toBe(1);
    await expect(
      owner.query('UPDATE reviews.helpful_votes SET created_at = now() WHERE review_id = $1', [
        review.id,
      ]),
    ).rejects.toBeDefined();
    // A vote on a review that is not there has no parent to point at.
    await expect(
      sql.query(
        `INSERT INTO reviews.helpful_votes (market_id, tenant_id, review_id, account_id, created_at)
         VALUES ($1, 'default', $2, $3, now())`,
        [market.marketId, ids.next<'ProductReview'>(), voter],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('lists by helpful count with a keyset that loses and repeats no review', async () => {
    const productId = ids.next<'Product'>();
    const made = [];
    for (let i = 0; i < 5; i += 1) {
      made.push(await publish({ productId }, new Date(Date.now() - (5 - i) * 60_000)));
    }
    // Helpful counts 0, 2, 1, 2, 0 so that the tie breaks on newer first.
    const plan: Array<[number, number]> = [
      [1, 2],
      [3, 2],
      [2, 1],
    ];
    for (const [index, votes] of plan) {
      for (let v = 0; v < votes; v += 1) {
        expect((await vote(ids.next<'Account'>(), made[index]!.publicId)).ok).toBe(true);
      }
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await new ListProductReviews(gate, deps).execute(anonymous, {
        productId,
        sort: 'helpful',
        cursor: cursor ?? undefined,
      });
      if (!page.ok) throw new Error(page.error.code);
      seen.push(...page.value.reviews.map((r) => r.id));
      cursor = page.value.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual([
      made[3]!.publicId,
      made[1]!.publicId,
      made[2]!.publicId,
      made[4]!.publicId,
      made[0]!.publicId,
    ]);
    const first = await new ListProductReviews(gate, deps).execute(anonymous, {
      productId,
      sort: 'helpful',
    });
    expect(first.ok && first.value.reviews[0]!.helpfulCount).toBe(2);
  });

  it('drops the votes of a deleted account and keeps the counts exact', async () => {
    const review = await publish();
    const voter = ids.next<'Account'>();
    expect((await vote(voter, review.publicId)).ok).toBe(true);
    expect(await countOf(review.id)).toBe(1);
    const detached = await new DetachAuthor(gate, deps).execute(system, { accountId: voter });
    expect(detached.ok).toBe(true);
    expect(await countOf(review.id)).toBe(0);
  });

  it('answers per-product totals for the search copy, page by page', async () => {
    const productId = ids.next<'Product'>();
    await publish({ productId, rating: 5 });
    await publish({ productId, rating: 4 });
    const rebuilt = await new RebuildRatingSummaries(gate, deps).execute(system, {});
    expect(rebuilt.ok).toBe(true);
    const all: Array<{ productId: string; count: number; sum: number }> = [];
    let after: string | undefined;
    for (let guard = 0; guard < 500; guard += 1) {
      const page = await new ListProductRatingTotals(gate, deps).execute(system, {
        limit: 100,
        after,
      });
      if (!page.ok) throw new Error(page.error.code);
      all.push(...page.value.items);
      if (page.value.next === null) break;
      after = page.value.next;
    }
    expect(all.find((t) => t.productId === productId)).toMatchObject({ count: 2, sum: 9 });
    expect(new Set(all.map((t) => t.productId)).size).toBe(all.length);
  });
});
