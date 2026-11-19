import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import {
  compareModeration,
  EMPTY_MODERATION_FILTER,
  MODERATION_LIST_VIEWS,
  moderationMatches,
  type ModerationFilter,
  type ModerationSort,
  type ModerationSubject,
} from '../../src/modules/reviews/domain/moderation-list';
import type { ReviewStatus } from '../../src/modules/reviews/domain/rules';
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

// The admin moderation list on PostgreSQL (super list 18), for both Market fixtures: the
// repository's views, filters, sorts, counts, id lookups and page windows against the in-memory
// twin (`moderationMatches`, `compareModeration`) that the unit specs use. Held, reported
// (with open, dismissed and actioned reports), hidden, removed, published and deleted reviews of
// two sellers, and a review of the other Market that must never show.

describe.each(TEST_MARKETS)('moderation list in market %s (database)', (code) => {
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
  const subjects: ModerationSubject[] = [];

  const insert = async (
    market_: typeof market,
    sellerId: Id<'Seller'>,
    extra: {
      rating: number;
      title: string | null;
      body: string | null;
      day: number;
      status: ReviewStatus;
      reports?: ('open' | 'dismissed' | 'actioned')[];
      reason?: string;
    },
  ) => {
    const id = ids.next<'ProductReview'>();
    const productId = ids.next<'Product'>();
    const offerId = ids.next<'Offer'>();
    const createdAt = T0.add({ hours: 24 * extra.day });
    await owner.query(
      `INSERT INTO reviews.product_reviews
         (id, market_id, tenant_id, account_id, product_id, offer_id, seller_id, last_seller_order_id,
          rating, title, body, locale, anonymous, status, created_at, published_at, deleted_at, last_purchase_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'en', false, $12, $13, $14, $15, now())`,
      [
        id,
        market_.marketId,
        market_.tenantId,
        buyer,
        productId,
        offerId,
        sellerId,
        ids.next<'SellerOrder'>(),
        extra.rating,
        extra.title,
        extra.body,
        extra.status,
        createdAt.toString(),
        extra.status === 'held' ? null : createdAt.toString(),
        extra.status === 'deleted-by-author' ? createdAt.toString() : null,
      ],
    );
    const openReasons: string[] = [];
    for (const status of extra.reports ?? []) {
      const reason = extra.reason ?? 'abusive';
      await owner.query(
        `INSERT INTO reviews.review_reports (id, market_id, tenant_id, review_id, reporter_account_id, reason_code, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [
          ids.next<'ReviewReport'>(),
          market_.marketId,
          market_.tenantId,
          id,
          ids.next<'Account'>(),
          reason,
          status,
        ],
      );
      if (status === 'open') openReasons.push(reason);
    }
    return { id, productId, offerId, createdAt, openReasons };
  };

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    repository = new PrismaReviewRepository(db.service);
    const plan = [
      { rating: 1, title: 'Late parcel', body: 'Took weeks', day: 1, status: 'held' as const },
      {
        rating: 2,
        title: 'Meh 100%_off',
        body: null,
        day: 2,
        status: 'published' as const,
        reports: ['open' as const, 'open' as const],
      },
      {
        rating: 3,
        title: null,
        body: 'Fine, as described',
        day: 3,
        status: 'published' as const,
        reports: ['dismissed' as const],
      },
      { rating: 4, title: 'Good', body: 'Quick and LOVELY', day: 3, status: 'hidden' as const },
      { rating: 5, title: 'Great', body: 'Would buy', day: 5, status: 'removed' as const },
      {
        rating: 5,
        title: 'Great too',
        body: 'Same day',
        day: 5,
        status: 'held' as const,
        sellerId: 'other',
        reports: ['open' as const],
        reason: 'spam',
      },
      { rating: 2, title: null, body: null, day: 6, status: 'deleted-by-author' as const },
      { rating: 3, title: '100xyoff', body: null, day: 6, status: 'published' as const },
    ];
    for (const row of plan) {
      const sellerId = 'sellerId' in row ? otherSeller : seller;
      const made = await insert(market, sellerId, row);
      subjects.push({
        id: made.id,
        productId: made.productId,
        offerId: made.offerId,
        sellerId,
        rating: row.rating,
        title: row.title,
        body: row.body,
        status: row.status,
        createdAt: made.createdAt,
        openReportReasons: made.openReasons,
      });
    }
    // A review of the same shop in the other Market that is in no queue view there either (a
    // held one would show in that Market's own run): it must not change what this Market lists.
    await insert(foreign, seller, {
      rating: 1,
      title: 'Late elsewhere',
      body: 'x',
      day: 1,
      status: 'published',
    });
  });
  afterAll(async () => {
    await db.close();
    await owner.end();
  });

  const inUnit = <T>(work: () => Promise<T>) =>
    db.unitOfWork.run(market, async () => ({ ok: true as const, value: await work() }), {
      readOnly: true,
    });
  // Other specs of the suite put reviews into the same Market: every read here is limited to the
  // days this spec writes (October 2026), and the view counts are compared as a lower bound.
  const WINDOW = { from: T0.subtract({ hours: 24 }), to: T0.add({ hours: 24 * 30 }) };
  const windowed = (filter: ModerationFilter): ModerationFilter => ({
    ...filter,
    from: filter.from ?? WINDOW.from,
    to: filter.to ?? WINDOW.to,
  });
  const read = (filter: ModerationFilter, sort: ModerationSort, offset = 0, limit = 50) =>
    inUnit(() => repository.queryModerationList(market, windowed(filter), sort, offset, limit));

  const FILTERS: readonly [string, Partial<ModerationFilter>][] = [
    ['all', {}],
    ['held', { view: 'held' }],
    ['reported', { view: 'reported' }],
    ['actioned', { view: 'actioned' }],
    ['stars 3 to 4', { minRating: 3, maxRating: 4 }],
    ['seller', { sellerId: seller }],
    ['other seller', { sellerId: otherSeller }],
    ['report reason', { reportReason: 'abusive' }],
    ['report reason none', { reportReason: 'extortion' }],
    ['text, case-insensitive', { text: 'late' }],
    ['text with a wildcard character', { text: '100%_off' }],
    ['text none', { text: 'no such thing' }],
    ['from', { from: T0.add({ hours: 24 * 3 }) }],
    ['to', { to: T0.add({ hours: 24 * 3 }) }],
    ['reported low', { view: 'reported', maxRating: 2 }],
  ];
  const SORTS: readonly ModerationSort[] = [
    { key: 'submitted', direction: 'desc' },
    { key: 'submitted', direction: 'asc' },
    { key: 'rating', direction: 'desc' },
    { key: 'rating', direction: 'asc' },
  ];

  it.each(FILTERS)('matches the in-memory twin: %s', async (_name, partial) => {
    const filter = windowed({ ...EMPTY_MODERATION_FILTER, ...partial });
    for (const sort of SORTS) {
      const expected = subjects
        .filter((s) => moderationMatches(s, filter))
        .sort((a, b) => compareModeration(a, b, sort))
        .map((s) => s.id);
      const got = await read(filter, sort);
      expect(got.ok && got.value.map((row) => row.review.id)).toEqual(expected);
      const count = await inUnit(() => repository.countModerationListWhere(market, filter));
      expect(count.ok && count.value).toBe(expected.length);
    }
  });

  it('matches an exact id of the review, its Offer or its product', async () => {
    const target = subjects[1]!;
    for (const anyId of [target.id, target.offerId, target.productId]) {
      const got = await read({ ...EMPTY_MODERATION_FILTER, anyId }, SORTS[0]!);
      expect(got.ok && got.value.map((row) => row.review.id)).toEqual([target.id]);
    }
  });

  it('counts only open reports and pages without repeating or skipping a row', async () => {
    const got = await read(EMPTY_MODERATION_FILTER, SORTS[2]!);
    const byId = new Map(got.ok ? got.value.map((row) => [row.review.id, row.openReports]) : []);
    for (const s of subjects.filter((x) => got.ok && byId.has(x.id))) {
      expect(byId.get(s.id)).toBe(s.openReportReasons.length);
    }
    const seen: string[] = [];
    for (let offset = 0; offset < subjects.length; offset += 2) {
      const page = await read(EMPTY_MODERATION_FILTER, SORTS[2]!, offset, 2);
      if (page.ok) seen.push(...page.value.map((row) => row.review.id));
    }
    expect(seen).toEqual(got.ok ? got.value.map((row) => row.review.id) : null);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('counts each view for the Market and finds only reviews in a queue view by id', async () => {
    const counts = await inUnit(() => repository.moderationViewCounts(market));
    const expected = Object.fromEntries(
      MODERATION_LIST_VIEWS.map((view) => [
        view,
        subjects.filter((s) => moderationMatches(s, { ...EMPTY_MODERATION_FILTER, view })).length,
      ]),
    );
    // Other specs may have reviews in the Market too: each view holds at least this spec's own.
    for (const view of MODERATION_LIST_VIEWS) {
      expect(counts.ok && counts.value[view]).toBeGreaterThanOrEqual(expected[view]!);
    }
    const inQueue = subjects.filter((s) => moderationMatches(s, EMPTY_MODERATION_FILTER));
    const outside = subjects.filter((s) => !moderationMatches(s, EMPTY_MODERATION_FILTER));
    const found = await inUnit(() =>
      repository.findModerationRowsByIds(market, [
        ...inQueue.slice(0, 3).map((s) => s.id),
        ...outside.map((s) => s.id),
      ]),
    );
    expect(found.ok && found.value.map((row) => row.review.id).sort()).toEqual(
      inQueue
        .slice(0, 3)
        .map((s) => s.id)
        .sort(),
    );
  });
});
