import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { ReviewsDependencies } from '../../src/modules/reviews/application/reviews-dependencies';
import { EditReviewReply } from '../../src/modules/reviews/application/use-cases/edit-review-reply.use-case';
import { ListSellerReviews } from '../../src/modules/reviews/application/use-cases/list-seller-reviews.use-case';
import { ReplyToReview } from '../../src/modules/reviews/application/use-cases/reply-to-review.use-case';
import { ReportReview } from '../../src/modules/reviews/application/use-cases/report-review.use-case';
import { ConfigReviewsPolicy } from '../../src/modules/reviews/infrastructure/config-reviews-policy';
import { PrismaMarketSettingRepository } from '../../src/modules/reviews/infrastructure/prisma-market-setting.repository';
import { PrismaReviewRepository } from '../../src/modules/reviews/infrastructure/prisma-review.repository';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import {
  FakeAffinity,
  FakeDeliveries,
  FakeNames,
  FakeOffers,
  FakeStepUp,
} from '../support/reviews-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The seller's side of reviews on the real stores (package 4), in both Market fixtures: the shop
// lists only its own published reviews, one reply per review even when two requests race, an edit
// keeps the row, a repeated report is one row, and the buyer never appears in what the shop reads.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

describe.each(TEST_MARKETS)('seller reviews in market %s (database)', (code) => {
  const market = marketOf(code);
  const clock = new FixedClock(Temporal.Instant.from('2026-11-01T10:00:00Z'));
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const seller = ids.next<'Seller'>();
  const otherSeller = ids.next<'Seller'>();
  const member = ids.next<'Account'>();
  const buyer = ids.next<'Account'>();
  const sellerCtx = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: member,
      sessionId: ids.next<'Session'>(),
      sellerId: seller,
    }),
    'reviews-seller-db-1',
  );

  let db: Persistence;
  let owner: Client;
  let deps: ReviewsDependencies;

  const rows = async (text: string, values: unknown[] = []) =>
    (await owner.query(text, values)).rows as Record<string, unknown>[];

  const insertReview = async (sellerId: Id<'Seller'>, status = 'published') => {
    const id = ids.next<'ProductReview'>();
    await owner.query(
      `INSERT INTO reviews.product_reviews
         (id, market_id, tenant_id, account_id, product_id, offer_id, seller_id, last_seller_order_id,
          rating, title, body, locale, anonymous, status, created_at, published_at, last_purchase_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 2, 'Meh', 'Slow delivery', 'en', false, $9, now(), now(), now())`,
      [
        id,
        market.marketId,
        market.tenantId,
        buyer,
        ids.next<'Product'>(),
        ids.next<'Offer'>(),
        sellerId,
        ids.next<'SellerOrder'>(),
        status,
      ],
    );
    return id;
  };

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    deps = {
      unitOfWork: db.unitOfWork,
      reviews: new PrismaReviewRepository(db.service),
      settings: new PrismaMarketSettingRepository(db.service),
      policy: new ConfigReviewsPolicy(markets),
      ordering: new FakeDeliveries().facade(),
      catalog: new FakeOffers().facade(),
      names: new FakeNames(),
      affinity: new FakeAffinity(),
      audit: { record: () => Promise.resolve() },
      stepUp: new FakeStepUp(),
      ids,
      clock,
    };
    await owner.query(
      `INSERT INTO reviews.market_settings (market_id, tenant_id, status, updated_at, updated_by_account_id)
       VALUES ($1, $2, 'active', now(), $3) ON CONFLICT (market_id) DO UPDATE SET status = 'active'`,
      [market.marketId, market.tenantId, ids.next<'Account'>()],
    );
  });
  afterAll(async () => {
    await db.close();
    await owner.end();
  });

  it("lists only the shop's published reviews and never carries the buyer", async () => {
    const mine = await insertReview(seller);
    await insertReview(otherSeller);
    await insertReview(seller, 'held');
    const result = await new ListSellerReviews(gate, deps).execute(sellerCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.map((r) => r.id)).toContain(mine);
    expect(result.value.items.every((r) => r.orderRef !== null)).toBe(true);
    expect(JSON.stringify(result.value)).not.toContain(buyer);
  });

  it('keeps one reply per review when two requests race, and edits it in place', async () => {
    const review = await insertReview(seller);
    const write = () =>
      new ReplyToReview(gate, deps).execute(sellerCtx, {
        reviewId: review,
        body: 'Sorry about that',
      });
    const [a, b] = await Promise.all([write(), write()]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const lost = a.ok ? b : a;
    expect(lost.ok ? null : lost.error.code).toBe('reviews.already-replied');
    const edited = await new EditReviewReply(gate, deps).execute(sellerCtx, {
      reviewId: review,
      body: 'We will make it right',
    });
    expect(edited.ok && edited.value.reply?.body).toBe('We will make it right');
    const stored = await rows(
      'SELECT body, edited_at FROM reviews.review_replies WHERE review_id = $1',
      [review],
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]!.body).toBe('We will make it right');
    expect(stored[0]!.edited_at).not.toBeNull();
  });

  it('records one open report per member and leaves the review published', async () => {
    const review = await insertReview(seller);
    const report = () =>
      new ReportReview(gate, deps).execute(sellerCtx, { reviewId: review, reasonCode: 'abusive' });
    expect((await report()).ok).toBe(true);
    expect((await report()).ok).toBe(true);
    const reports = await rows(
      'SELECT status, reporter_account_id FROM reviews.review_reports WHERE review_id = $1',
      [review],
    );
    expect(reports).toEqual([{ status: 'open', reporter_account_id: member }]);
    const status = (
      await rows('SELECT status FROM reviews.product_reviews WHERE id = $1', [review])
    )[0]!.status;
    expect(status).toBe('published');
  });

  it("answers not-found for another shop's review without writing", async () => {
    const foreign = await insertReview(otherSeller);
    const result = await new ReplyToReview(gate, deps).execute(sellerCtx, {
      reviewId: foreign,
      body: 'Hello',
    });
    expect(result.ok ? null : result.error.code).toBe('reviews.not-found');
    const count = (
      await rows('SELECT count(*)::int AS n FROM reviews.review_replies WHERE review_id = $1', [
        foreign,
      ])
    )[0]!.n;
    expect(count).toBe(0);
  });
});
