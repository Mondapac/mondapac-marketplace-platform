import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { DeleteProductReview } from '../../src/modules/reviews/application/use-cases/delete-product-review.use-case';
import { DetachAuthor } from '../../src/modules/reviews/application/use-cases/detach-author.use-case';
import { ListProductReviews } from '../../src/modules/reviews/application/use-cases/list-product-reviews.use-case';
import { RateSellerOrder } from '../../src/modules/reviews/application/use-cases/rate-seller-order.use-case';
import { RebuildRatingSummaries } from '../../src/modules/reviews/application/use-cases/rebuild-rating-summaries.use-case';
import { SetReviewsStatus } from '../../src/modules/reviews/application/use-cases/set-reviews-status.use-case';
import { SubmitProductReview } from '../../src/modules/reviews/application/use-cases/submit-product-review.use-case';
import { ViewProductSummary } from '../../src/modules/reviews/application/use-cases/view-product-summary.use-case';
import { ViewSellerSummary } from '../../src/modules/reviews/application/use-cases/view-seller-summary.use-case';
import type { ReviewsDependencies } from '../../src/modules/reviews/application/reviews-dependencies';
import { ConfigReviewsPolicy } from '../../src/modules/reviews/infrastructure/config-reviews-policy';
import { PrismaMarketSettingRepository } from '../../src/modules/reviews/infrastructure/prisma-market-setting.repository';
import { PrismaReviewRepository } from '../../src/modules/reviews/infrastructure/prisma-review.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { FakeAffinity, FakeDeliveries, FakeNames, FakeOffers } from '../support/reviews-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Reviews as the application role in both Market fixtures: the tables' own guards (the unique
// keys, the CHECKs, insert-only logs, no delete, column-level grants, no key to another schema),
// and the use cases on the real stores: a submit, an edit, a delete, the one-row guarantee of
// two parallel submits, the summary rebuild after drift and the detach of a deleted account.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const CHECK = '23514';
const NO_PRIVILEGE = '42501';
const RESTRICT = '23001';
const UNIQUE = '23505';
const TABLES = [
  'product_reviews',
  'seller_ratings',
  'review_replies',
  'review_reports',
  'moderation_actions',
  'review_signals',
  'rating_summaries',
  'market_settings',
] as const;

describe.each(TEST_MARKETS)('reviews in market %s (database)', (code) => {
  const market = marketOf(code);
  const config = markets.get(market.marketId);
  const rules = config.reviews!;
  // In the past, so that rows made with the injected clock sort before any later row.
  const clock = new FixedClock(Temporal.Instant.from('2020-03-02T10:00:00Z'));
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const system = testCallContext(market, 'system', 'reviews-db-system-1');
  const anonymous = testCallContext(market, 'anonymous', 'reviews-db-anon-1');
  const admin = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: ids.next<'Account'>(),
      sessionId: ids.next<'Session'>(),
      sellerId: null,
    }),
    'reviews-db-admin-1',
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
      'reviews-db-customer-1',
    );

  let db: Persistence;
  let sql: Client;
  let owner: Client;
  let deps: ReviewsDependencies;
  let deliveries: FakeDeliveries;
  let offers: FakeOffers;

  beforeAll(async () => {
    db = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
    deliveries = new FakeDeliveries();
    offers = new FakeOffers();
    deps = {
      unitOfWork: db.unitOfWork,
      reviews: new PrismaReviewRepository(db.service),
      settings: new PrismaMarketSettingRepository(db.service),
      policy: new ConfigReviewsPolicy(markets),
      ordering: deliveries.facade(),
      catalog: offers.facade(),
      names: new FakeNames(),
      affinity: new FakeAffinity(),
      audit: { record: () => Promise.resolve() },
      ids,
      clock,
    };
    // Real time is after the 2020 clock, so a delivery "yesterday" by the injected clock is in
    // the window of the rules (the clock is only read for the window and the log).
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
    await owner.end();
  });

  const code_ = (promise: Promise<unknown>) =>
    promise.then(
      () => 'allowed',
      (error: { code?: string }) => error.code,
    );
  const rows = async (text: string, values: unknown[] = []) =>
    (await owner.query(text, values)).rows as Record<string, unknown>[];

  // ---- the tables' own guards ---------------------------------------------------------------

  describe('tables', () => {
    const mk = `T${code}`;
    const reviewSql = (overrides: Record<string, unknown> = {}): [string, unknown[]] => {
      const v = {
        id: ids.next<'ProductReview'>(),
        market_id: mk,
        tenant_id: 'default',
        account_id: ids.next<'Account'>(),
        product_id: ids.next<'Product'>(),
        offer_id: ids.next<'Offer'>(),
        seller_id: ids.next<'Seller'>(),
        last_seller_order_id: ids.next<'SellerOrder'>(),
        rating: 5,
        title: 'Good',
        body: 'Good stuff',
        locale: 'en-AU',
        anonymous: false,
        status: 'published',
        created_at: new Date(),
        edited_at: null,
        published_at: new Date(),
        deleted_at: null,
        last_purchase_at: new Date(),
        ...overrides,
      };
      const keys = Object.keys(v);
      return [
        `INSERT INTO reviews.product_reviews (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(v),
      ];
    };
    const ratingSql = (overrides: Record<string, unknown> = {}): [string, unknown[]] => {
      const v = {
        id: ids.next<'SellerRating'>(),
        market_id: mk,
        tenant_id: 'default',
        account_id: ids.next<'Account'>(),
        seller_order_id: ids.next<'SellerOrder'>(),
        seller_id: ids.next<'Seller'>(),
        satisfaction: 4,
        as_described: true,
        arrived_ok: true,
        reason_code: null,
        status: 'published',
        created_at: new Date(),
        ...overrides,
      };
      const keys = Object.keys(v);
      return [
        `INSERT INTO reviews.seller_ratings (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(v),
      ];
    };
    const run = (statement: [string, unknown[]], client: Client = sql) =>
      code_(client.query(...statement));

    it('every table carries market_id and tenant_id, and none has a key to another schema', async () => {
      const columns = await rows(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'reviews' AND column_name IN ('market_id', 'tenant_id')`,
      );
      for (const table of TABLES) {
        const own = columns.filter((c) => c.table_name === table).map((c) => c.column_name);
        expect(own.sort()).toEqual(['market_id', 'tenant_id']);
      }
      const foreign = await rows(
        `SELECT c.conname FROM pg_constraint c
           JOIN pg_namespace n ON n.oid = c.connamespace
           JOIN pg_class t ON t.oid = c.confrelid
           JOIN pg_namespace tn ON tn.oid = t.relnamespace
          WHERE c.contype = 'f' AND n.nspname = 'reviews' AND tn.nspname <> 'reviews'`,
      );
      expect(foreign).toEqual([]);
    });

    it('keeps one review per account and product, and many once the author link is dropped', async () => {
      const account = ids.next<'Account'>();
      const productId = ids.next<'Product'>();
      expect(await run(reviewSql({ account_id: account, product_id: productId }))).toBe('allowed');
      expect(await run(reviewSql({ account_id: account, product_id: productId }))).toBe(UNIQUE);
      expect(await run(reviewSql({ account_id: null, product_id: productId }))).toBe('allowed');
      expect(await run(reviewSql({ account_id: null, product_id: productId }))).toBe('allowed');
    });

    it('keeps one rating per seller order', async () => {
      const order = ids.next<'SellerOrder'>();
      expect(await run(ratingSql({ seller_order_id: order }))).toBe('allowed');
      expect(await run(ratingSql({ seller_order_id: order }))).toBe(UNIQUE);
    });

    it('refuses rows the CHECKs name', async () => {
      expect(await run(reviewSql({ rating: 0 }))).toBe(CHECK);
      expect(await run(reviewSql({ rating: 6 }))).toBe(CHECK);
      expect(await run(reviewSql({ status: 'pending' }))).toBe(CHECK);
      expect(await run(reviewSql({ market_id: 'bad' }))).toBe(CHECK);
      expect(await run(reviewSql({ tenant_id: 'Bad Tenant' }))).toBe(CHECK);
      expect(await run(reviewSql({ body: '' }))).toBe(CHECK);
      expect(await run(reviewSql({ body: 'x'.repeat(5001) }))).toBe(CHECK);
      // Published needs its time; deleted-by-author needs its time and no text.
      expect(await run(reviewSql({ published_at: null }))).toBe(CHECK);
      expect(
        await run(
          reviewSql({
            status: 'deleted-by-author',
            deleted_at: null,
            published_at: null,
            title: null,
            body: null,
          }),
        ),
      ).toBe(CHECK);
      expect(
        await run(
          reviewSql({ status: 'deleted-by-author', deleted_at: new Date(), published_at: null }),
        ),
      ).toBe(CHECK);
      expect(await run(ratingSql({ satisfaction: 0 }))).toBe(CHECK);
      expect(await run(ratingSql({ arrived_ok: true, reason_code: 'damaged' }))).toBe(CHECK);
      expect(await run(ratingSql({ arrived_ok: false, reason_code: 'lost' }))).toBe(CHECK);
      expect(await run(ratingSql({ arrived_ok: false, reason_code: 'damaged' }))).toBe('allowed');
      const summary = (counts: Record<string, number>, kind = 'product') =>
        run([
          `INSERT INTO reviews.rating_summaries (market_id, tenant_id, subject_kind, subject_id, count, sum,
             histogram_1, histogram_2, histogram_3, histogram_4, histogram_5, rated_seller_orders,
             satisfied_count, as_described_yes, arrived_ok_yes, rebuilt_at)
           VALUES ($1, 'default', $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, 0, 0, 0, now())`,
          [
            mk,
            kind,
            ids.next(),
            counts.count,
            counts.sum,
            counts.h1,
            counts.h2,
            counts.h3,
            counts.h4,
            counts.h5,
          ],
        ]);
      expect(await summary({ count: 2, sum: 9, h1: 0, h2: 0, h3: 0, h4: 1, h5: 1 })).toBe(
        'allowed',
      );
      expect(await summary({ count: 2, sum: 8, h1: 0, h2: 0, h3: 0, h4: 1, h5: 1 })).toBe(CHECK);
      expect(await summary({ count: 3, sum: 9, h1: 0, h2: 0, h3: 0, h4: 1, h5: 1 })).toBe(CHECK);
      expect(await summary({ count: 0, sum: 0, h1: 0, h2: 0, h3: 0, h4: 0, h5: 0 }, 'other')).toBe(
        CHECK,
      );
    });

    it('makes the moderation log and the signals insert-only for every role', async () => {
      const review = reviewSql();
      await sql.query(...review);
      const reviewId = review[1][0];
      const action = ids.next();
      await sql.query(
        `INSERT INTO reviews.moderation_actions (id, market_id, tenant_id, review_id, actor_account_id, action, reason_code, from_status, to_status, created_at)
         VALUES ($1, $2, 'default', $3, NULL, 'publish', 'submitted', NULL, 'published', now())`,
        [action, mk, reviewId],
      );
      const signal = ids.next();
      await sql.query(
        `INSERT INTO reviews.review_signals (id, market_id, tenant_id, subject_kind, subject_id, code, at)
         VALUES ($1, $2, 'default', 'product-review', $3, 'profanity', now())`,
        [signal, mk, reviewId],
      );
      for (const [table, rowId] of [
        ['moderation_actions', action],
        ['review_signals', signal],
      ] as const) {
        expect(
          await code_(
            sql.query(`UPDATE reviews.${table} SET market_id = market_id WHERE id = $1`, [rowId]),
          ),
        ).toBe(NO_PRIVILEGE);
        expect(await code_(sql.query(`DELETE FROM reviews.${table} WHERE id = $1`, [rowId]))).toBe(
          NO_PRIVILEGE,
        );
        expect(
          await code_(
            owner.query(`UPDATE reviews.${table} SET market_id = market_id WHERE id = $1`, [rowId]),
          ),
        ).toBe(RESTRICT);
        expect(
          await code_(owner.query(`DELETE FROM reviews.${table} WHERE id = $1`, [rowId])),
        ).toBe(RESTRICT);
        expect(await code_(owner.query(`TRUNCATE reviews.${table} CASCADE`))).toBe(RESTRICT);
      }
      // A log row names a review that exists in the same Market.
      expect(
        await code_(
          sql.query(
            `INSERT INTO reviews.moderation_actions (id, market_id, tenant_id, review_id, action, reason_code, to_status, created_at)
             VALUES ($1, $2, 'default', $3, 'publish', 'submitted', 'published', now())`,
            [ids.next(), mk, ids.next()],
          ),
        ),
      ).toBe('23503');
    });

    it('never deletes a review or a rating, and lets the application change only the granted columns', async () => {
      const review = reviewSql();
      await sql.query(...review);
      const reviewId = review[1][0];
      expect(
        await code_(sql.query(`DELETE FROM reviews.product_reviews WHERE id = $1`, [reviewId])),
      ).toBe(NO_PRIVILEGE);
      expect(
        await code_(owner.query(`DELETE FROM reviews.product_reviews WHERE id = $1`, [reviewId])),
      ).toBe(RESTRICT);
      expect(await code_(owner.query(`TRUNCATE reviews.product_reviews CASCADE`))).toBe(RESTRICT);
      expect(await code_(owner.query(`TRUNCATE reviews.seller_ratings CASCADE`))).toBe(RESTRICT);
      expect(
        await code_(
          sql.query(`UPDATE reviews.product_reviews SET status = 'hidden' WHERE id = $1`, [
            reviewId,
          ]),
        ),
      ).toBe('allowed');
      // The Market, the tenant and the id are never rewritten.
      for (const column of ['market_id', 'tenant_id', 'id']) {
        expect(
          await code_(
            sql.query(`UPDATE reviews.product_reviews SET ${column} = ${column} WHERE id = $1`, [
              reviewId,
            ]),
          ),
        ).toBe(NO_PRIVILEGE);
      }
    });
  });

  // ---- the use cases on the real stores -----------------------------------------------------

  describe('use cases', () => {
    const bought = (accountId: Id<'Account'>, productId: Id<'Product'>, sellerId: Id<'Seller'>) => {
      const offerId = ids.next<'Offer'>();
      const sellerOrderId = ids.next<'SellerOrder'>();
      offers.offers.set(offerId, { productId, sellerId });
      // Delivered a moment ago in real time: the window is measured against the injected clock,
      // which is set to "now" for these tests.
      deliveries.add(accountId, {
        sellerOrderId,
        sellerId,
        deliveredAt: clock.now().subtract({ hours: 24 }),
        offerIds: [offerId],
      });
      return sellerOrderId;
    };
    const submit = (accountId: Id<'Account'>, productId: Id<'Product'>, extra: object = {}) =>
      new SubmitProductReview(gate, deps).execute(customer(accountId), {
        productId,
        rating: 4,
        title: 'Nice',
        body: 'Arrived well',
        ...extra,
      });

    beforeAll(async () => {
      clock.set(Temporal.Instant.from(new Date().toISOString()));
      const on = await new SetReviewsStatus(gate, deps).execute(admin, { status: 'active' });
      expect(on.ok).toBe(true);
    });

    it('writes, lists, edits, deletes and counts a review on the real tables', async () => {
      const account = ids.next<'Account'>();
      const productId = ids.next<'Product'>();
      const seller = ids.next<'Seller'>();
      bought(account, productId, seller);
      const created = await submit(account, productId);
      expect(created).toMatchObject({ ok: true, value: { outcome: 'created' } });
      if (!created.ok) throw new Error();

      const summary = await new ViewProductSummary(gate, deps).execute(anonymous, { productId });
      expect(summary).toMatchObject({ ok: true, value: { count: 1, averageTimes100: 400 } });
      const page = await new ListProductReviews(gate, deps).execute(anonymous, { productId });
      expect(page).toMatchObject({
        ok: true,
        value: { reviews: [{ rating: 4, body: 'Arrived well' }] },
      });

      const log = await rows(
        `SELECT action, to_status FROM reviews.moderation_actions WHERE review_id = $1`,
        [created.value.review.id],
      );
      expect(log).toEqual([{ action: 'publish', to_status: 'published' }]);

      const removed = await new DeleteProductReview(gate, deps).execute(customer(account), {
        reviewId: created.value.review.id,
      });
      expect(removed).toEqual(ok({ id: created.value.review.id, status: 'deleted-by-author' }));
      const stored = await rows(
        `SELECT title, body, status FROM reviews.product_reviews WHERE id = $1`,
        [created.value.review.id],
      );
      expect(stored).toEqual([{ title: null, body: null, status: 'deleted-by-author' }]);
      expect(
        await new ViewProductSummary(gate, deps).execute(anonymous, { productId }),
      ).toMatchObject({ ok: true, value: { count: 0 } });
    });

    it('holds a flagged review: signal rows with codes only, nothing public', async () => {
      const account = ids.next<'Account'>();
      const productId = ids.next<'Product'>();
      bought(account, productId, ids.next<'Seller'>());
      const blocked = rules.autoChecks.blockedTerms[0]!;
      const done = await submit(account, productId, { body: `so ${blocked}` });
      if (!done.ok) throw new Error(done.error.code);
      expect(done.value.review.status).toBe('held');
      const signals = await rows(`SELECT code FROM reviews.review_signals WHERE subject_id = $1`, [
        done.value.review.id,
      ]);
      expect(signals).toEqual([{ code: 'profanity' }]);
      expect(
        await new ListProductReviews(gate, deps).execute(anonymous, { productId }),
      ).toMatchObject({ ok: true, value: { reviews: [] } });
    });

    it('two submits at once leave exactly one review row', async () => {
      const account = ids.next<'Account'>();
      const productId = ids.next<'Product'>();
      bought(account, productId, ids.next<'Seller'>());
      const results = await Promise.all([submit(account, productId), submit(account, productId)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const failed = results.find((r) => !r.ok);
      expect(failed).toMatchObject({ ok: false, error: { code: 'reviews.already-reviewed' } });
      const count = await rows(
        `SELECT count(*)::int AS n FROM reviews.product_reviews WHERE account_id = $1 AND product_id = $2`,
        [account, productId],
      );
      expect(count[0]!.n).toBe(1);
    });

    it('rates a seller order once, even when asked at the same time', async () => {
      const account = ids.next<'Account'>();
      const seller = ids.next<'Seller'>();
      const order = bought(account, ids.next<'Product'>(), seller);
      const rate = () =>
        new RateSellerOrder(gate, deps).execute(customer(account), {
          sellerOrderId: order,
          satisfaction: 4,
          asDescribed: true,
          arrivedOk: true,
        });
      const results = await Promise.all([rate(), rate()]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toMatchObject({
        ok: false,
        error: { code: 'reviews.already-rated' },
      });
      const summary = await new ViewSellerSummary(gate, deps).execute(anonymous, {
        sellerId: seller,
      });
      expect(summary).toMatchObject({
        ok: true,
        value: { count: 1, averageTimes100: 400, satisfiedBps: 10000 },
      });
    });

    it('rebuilds a drifted summary from the published rows', async () => {
      const account = ids.next<'Account'>();
      const productId = ids.next<'Product'>();
      bought(account, productId, ids.next<'Seller'>());
      await submit(account, productId, { rating: 2 });
      // Drift: the stored summary no longer matches the source rows (made consistent for the CHECK).
      await owner.query(
        `UPDATE reviews.rating_summaries SET count = 3, sum = 15, histogram_2 = 0, histogram_5 = 3
          WHERE market_id = $1 AND subject_kind = 'product' AND subject_id = $2`,
        [market.marketId, productId],
      );
      expect(
        await new ViewProductSummary(gate, deps).execute(anonymous, { productId }),
      ).toMatchObject({ ok: true, value: { count: 3 } });
      const rebuilt = await new RebuildRatingSummaries(gate, deps).execute(system, {});
      expect(rebuilt.ok).toBe(true);
      expect(
        await new ViewProductSummary(gate, deps).execute(anonymous, { productId }),
      ).toMatchObject({ ok: true, value: { count: 1, averageTimes100: 200 } });
    });

    it('detaches a deleted account and leaves the review as Former customer', async () => {
      const account = ids.next<'Account'>();
      const productId = ids.next<'Product'>();
      bought(account, productId, ids.next<'Seller'>());
      await submit(account, productId);
      const detached = await new DetachAuthor(gate, deps).execute(system, { accountId: account });
      expect(detached).toEqual(ok({ reviews: 1, ratings: 0 }));
      const page = await new ListProductReviews(gate, deps).execute(anonymous, { productId });
      expect(page).toMatchObject({
        ok: true,
        value: { reviews: [{ author: { kind: 'former-customer' }, body: 'Arrived well' }] },
      });
    });
  });
});
