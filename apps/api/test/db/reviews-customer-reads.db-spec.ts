import { randomUUID } from 'node:crypto';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import type { AccountWindow } from '../../src/modules/reviews/application/ports/customer-reviews.reader';
import { PrismaCustomerReviewsReader } from '../../src/modules/reviews/infrastructure/prisma-customer-reviews.reader';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The admin's reads of one customer's reviews (customers management phase 2b, part 3) on
// PostgreSQL as the application role, for both Market fixtures: one account's reviews with their
// open reports and latest moderation line, its seller ratings, its helpful votes and the reports
// by and about it; each in both directions with a window, a status or role filter and a count,
// never another account's or another Market's rows; and the author of one review. All rows are
// synthetic, written by the owner role.

const NOW = Temporal.Instant.from('2026-11-16T10:00:00Z');
const at = (hoursAgo: number) =>
  new Date(NOW.subtract({ minutes: Math.round(hoursAgo * 60) }).epochMilliseconds);
const desc = (limit = 50): AccountWindow => ({ direction: 'desc', offset: 0, limit });

describe.each(TEST_MARKETS)('the customer page reviews reads in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const customer = randomUUID() as Id<'Account'>;
  const stranger = randomUUID() as Id<'Account'>;
  const seller = randomUUID() as Id<'Seller'>;
  let db: Persistence;
  let owner: Client;
  let reader: PrismaCustomerReviewsReader;
  const reviewIds: Record<string, string> = {};

  const read = async <T>(m: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(m, async () => ok(await work()), { readOnly: true });
    if (!result.ok) throw new Error('read failed');
    return result.value;
  };
  const sql = (text: string, values: unknown[]) => owner.query(text, values);

  async function review(
    m: MarketContext,
    accountId: Id<'Account'> | null,
    status: string,
    hoursAgo: number,
  ): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO reviews.product_reviews
         (id, market_id, tenant_id, account_id, product_id, offer_id, seller_id, last_seller_order_id,
          rating, title, body, locale, anonymous, status, created_at, published_at, last_purchase_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 4, 'Mock', 'Mock text', 'en', false, $9, $10, $11, $10)`,
      [
        id,
        m.marketId,
        m.tenantId,
        accountId,
        randomUUID(),
        randomUUID(),
        seller,
        accountId === null ? null : randomUUID(),
        status,
        at(hoursAgo),
        status === 'published' ? at(hoursAgo) : null,
      ],
    );
    return id;
  }

  async function moderation(
    m: MarketContext,
    reviewId: string,
    action: string,
    by: string | null,
    h: number,
  ) {
    await sql(
      `INSERT INTO reviews.moderation_actions
         (id, market_id, tenant_id, review_id, actor_account_id, action, reason_code, from_status,
          to_status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'mock-reason', NULL, 'hidden', $7)`,
      [randomUUID(), m.marketId, m.tenantId, reviewId, by, action, at(h)],
    );
  }

  async function report(
    m: MarketContext,
    reviewId: string,
    reporter: string | null,
    status: string,
    h: number,
  ): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO reviews.review_reports
         (id, market_id, tenant_id, review_id, reporter_account_id, reason_code, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'off-topic', $6, $7)`,
      [id, m.marketId, m.tenantId, reviewId, reporter, status, at(h)],
    );
    return id;
  }

  async function rating(m: MarketContext, accountId: string, status: string, h: number) {
    await sql(
      `INSERT INTO reviews.seller_ratings
         (id, market_id, tenant_id, account_id, seller_order_id, seller_id, satisfaction,
          as_described, arrived_ok, reason_code, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 2, true, false, 'damaged', $7, $8)`,
      [randomUUID(), m.marketId, m.tenantId, accountId, randomUUID(), seller, status, at(h)],
    );
  }

  async function vote(m: MarketContext, reviewId: string, accountId: string, h: number) {
    await sql(
      `INSERT INTO reviews.helpful_votes (market_id, tenant_id, review_id, account_id, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [m.marketId, m.tenantId, reviewId, accountId, at(h)],
    );
  }

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    reader = new PrismaCustomerReviewsReader(db.service);

    reviewIds['published'] = await review(market, customer, 'published', 3);
    reviewIds['hidden'] = await review(market, customer, 'hidden', 2);
    reviewIds['held'] = await review(market, customer, 'held', 1);
    reviewIds['elsewhere'] = await review(other, customer, 'published', 1);
    reviewIds['strangers'] = await review(market, stranger, 'published', 4);
    reviewIds['detached'] = await review(market, null, 'published', 5);

    await moderation(market, reviewIds['hidden'], 'auto-hold', null, 2);
    await moderation(market, reviewIds['hidden'], 'hide', randomUUID(), 1);

    // About the customer: two on the hidden review (one still open), one by a reporter since
    // deleted. By the customer: one on a stranger's review. Elsewhere and on others: not theirs.
    await report(market, reviewIds['hidden'], randomUUID(), 'open', 2);
    await report(market, reviewIds['hidden'], randomUUID(), 'dismissed', 1.5);
    await report(market, reviewIds['published'], null, 'actioned', 1.2);
    reviewIds['byReport'] = await report(market, reviewIds['strangers'], customer, 'open', 1);
    await report(market, reviewIds['strangers'], randomUUID(), 'open', 0.5);
    await report(other, reviewIds['elsewhere'], randomUUID(), 'open', 0.5);

    await rating(market, customer, 'published', 3);
    await rating(market, customer, 'hidden', 2);
    await rating(other, customer, 'published', 1);
    await rating(market, stranger, 'published', 1);

    await vote(market, reviewIds['strangers'], customer, 2);
    await vote(market, reviewIds['detached'], customer, 1);
    await vote(market, reviewIds['published'], stranger, 1);
  });

  afterAll(async () => {
    await db.close();
    await owner.end();
  });

  it('pages the account’s reviews with open reports and the latest moderation line', async () => {
    const rows = await read(market, () => reader.reviewsOf(market, customer, null, desc()));
    expect(rows.map((r) => r.id)).toEqual([
      reviewIds['held'],
      reviewIds['hidden'],
      reviewIds['published'],
    ]);
    const hidden = rows[1]!;
    expect(hidden).toMatchObject({ status: 'hidden', openReports: 1, sellerId: seller });
    expect(hidden.lastModeration).toMatchObject({ action: 'hide', byModerator: true });
    expect(rows[0]!.lastModeration).toBeNull();
    expect(JSON.stringify(rows)).not.toContain('Mock');

    const oldest = await read(market, () =>
      reader.reviewsOf(market, customer, null, { direction: 'asc', offset: 1, limit: 1 }),
    );
    expect(oldest.map((r) => r.id)).toEqual([reviewIds['hidden']]);
    const filtered = await read(market, () =>
      reader.reviewsOf(market, customer, ['published', 'held'], desc()),
    );
    expect(filtered.map((r) => r.status)).toEqual(['held', 'published']);
    expect(await read(market, () => reader.reviewsOf(market, customer, [], desc()))).toEqual([]);
    expect(await read(market, () => reader.countReviewsOf(market, customer, null))).toBe(3);
    expect(await read(market, () => reader.countReviewsOf(market, customer, ['hidden']))).toBe(1);
    expect(await read(other, () => reader.countReviewsOf(other, customer, null))).toBe(1);
  });

  it('pages the account’s seller ratings by status', async () => {
    const rows = await read(market, () => reader.sellerRatingsOf(market, customer, null, desc()));
    expect(rows.map((r) => r.status)).toEqual(['hidden', 'published']);
    expect(rows[0]).toMatchObject({ satisfaction: 2, arrivedOk: false, reasonCode: 'damaged' });
    expect(
      await read(market, () => reader.countSellerRatingsOf(market, customer, ['published'])),
    ).toBe(1);
  });

  it('pages the account’s helpful votes with the product voted for, never the author', async () => {
    const rows = await read(market, () => reader.helpfulVotesOf(market, customer, desc()));
    expect(rows.map((r) => r.reviewId)).toEqual([reviewIds['detached'], reviewIds['strangers']]);
    expect(Object.keys(rows[0]!).sort()).toEqual(['productId', 'reviewId', 'votedAt']);
    expect(await read(market, () => reader.countHelpfulVotesOf(market, customer))).toBe(2);
  });

  it('pages the reports by and about the account, never the reporter', async () => {
    const both = await read(market, () => reader.reportsOf(market, customer, null, desc()));
    expect(both.map((r) => [r.role, r.status])).toEqual([
      ['by', 'open'],
      ['about', 'actioned'],
      ['about', 'dismissed'],
      ['about', 'open'],
    ]);
    expect(both[0]!.id).toBe(reviewIds['byReport']);
    expect(JSON.stringify(both)).not.toContain('reporter');
    const about = await read(market, () => reader.reportsOf(market, customer, ['about'], desc(2)));
    expect(about.map((r) => r.role)).toEqual(['about', 'about']);
    expect(await read(market, () => reader.countReportsOf(market, customer, ['by']))).toBe(1);
    expect(await read(market, () => reader.countReportsOf(market, customer, null))).toBe(4);
    expect(await read(market, () => reader.countReportsOf(market, customer, []))).toBe(0);
    expect(await read(other, () => reader.countReportsOf(other, customer, null))).toBe(1);
  });

  it('names a review’s author, null once detached, undefined when unknown here', async () => {
    const id = reviewIds['published'] as Id<'ProductReview'>;
    expect(await read(market, () => reader.authorOf(market, id))).toBe(customer);
    expect(
      await read(market, () =>
        reader.authorOf(market, reviewIds['detached'] as Id<'ProductReview'>),
      ),
    ).toBeNull();
    expect(await read(other, () => reader.authorOf(other, id))).toBeUndefined();
  });

  it('reads the reports one account made through the reporter index', async () => {
    const plan = await owner.query(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'reviews' AND indexname = 'review_reports_market_id_reporter_account_id_created_at_idx'`,
    );
    expect(plan.rows).toEqual([
      {
        indexdef:
          'CREATE INDEX review_reports_market_id_reporter_account_id_created_at_idx ON reviews.review_reports USING btree (market_id, reporter_account_id, created_at DESC)',
      },
    ]);
  });
});
