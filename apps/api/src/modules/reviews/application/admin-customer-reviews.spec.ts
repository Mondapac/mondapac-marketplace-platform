import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { ReviewStatus } from '../domain/rules';
import { CustomerReviewsFacadeImplementation } from '../presentation/customer-reviews.facade';
import type { AdminCustomerReviewsDependencies } from './admin-customer-reviews';
import type { AccountReviewRow } from './ports/customer-reviews.reader';
import { MemoryCustomerReviews } from './testing/in-memory-customer-reviews';
import { AdminCustomerHelpfulVotes } from './use-cases/admin-customer-helpful-votes.use-case';
import { AdminCustomerReviewReports } from './use-cases/admin-customer-review-reports.use-case';
import { AdminCustomerReviews } from './use-cases/admin-customer-reviews.use-case';
import { AdminCustomerSellerRatings } from './use-cases/admin-customer-seller-ratings.use-case';
import { ReviewAuthorOf } from './use-cases/review-author-of.use-case';

// The admin's reads of one customer's reviews (customers management phase 2b, part 3) on both
// Market fixtures: the four lists page through the reader with the filters and both counting
// modes, an unknown filter value never widens a read, only a platform admin (not seller-scoped,
// not acting as anyone) reads, and the author lookup is the system's only and names no one for an
// unknown or detached review.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
const T0 = Temporal.Instant.from('2026-11-16T00:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const CUSTOMER = id<'Account'>(0xc1);
const OTHER = id<'Account'>(0xc2);

describe.each([['AU'], ['ZZ']] as const)(
  'the admin’s reads of a customer’s reviews in %s',
  (code) => {
    const market = testMarketContext(code, 'default');
    const elsewhere = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
    const actor = (population: 'admin' | 'customer' | 'seller', sellerId: Id<'Seller'> | null) =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population,
          accountId: id<'Account'>(0xa1),
          sessionId: id<'Session'>(0xa2),
          sellerId,
        }),
      );
    const admin = (): CallContext => actor('admin', null);
    const at = (hours: number) => T0.add({ hours });

    function setUp() {
      const reader = new MemoryCustomerReviews();
      const deps: AdminCustomerReviewsDependencies = { unitOfWork: new FakeUnitOfWork(), reader };
      const facade = new CustomerReviewsFacadeImplementation(
        new AdminCustomerReviews(gate, deps),
        new AdminCustomerSellerRatings(gate, deps),
        new AdminCustomerHelpfulVotes(gate, deps),
        new AdminCustomerReviewReports(gate, deps),
        new ReviewAuthorOf(gate, deps),
      );
      const review = (n: number, status: ReviewStatus, moderated: boolean): AccountReviewRow => ({
        id: id<'ProductReview'>(0x100 + n),
        productId: id<'Product'>(0x200 + n),
        offerId: id<'Offer'>(0x300 + n),
        sellerId: id<'Seller'>(0x400),
        rating: n,
        anonymous: n % 2 === 0,
        status,
        createdAt: at(n),
        editedAt: null,
        publishedAt: status === 'published' ? at(n) : null,
        helpfulCount: n * 2,
        openReports: moderated ? 1 : 0,
        lastModeration: moderated
          ? { action: 'hide', reasonCode: 'abusive', byModerator: true, at: at(n + 1) }
          : null,
      });
      reader.reviews.push(
        { market: market.marketId, accountId: CUSTOMER, row: review(1, 'published', false) },
        { market: market.marketId, accountId: CUSTOMER, row: review(2, 'hidden', true) },
        { market: market.marketId, accountId: CUSTOMER, row: review(3, 'held', false) },
        { market: elsewhere.marketId, accountId: CUSTOMER, row: review(4, 'published', false) },
        { market: market.marketId, accountId: OTHER, row: review(5, 'published', false) },
      );
      return { reader, facade };
    }

    const request = (
      over: Partial<{ direction: 'asc' | 'desc'; limit: number; withTotal: boolean }> = {},
    ) => ({
      accountId: CUSTOMER,
      direction: over.direction ?? ('desc' as const),
      window: { offset: 0, limit: over.limit ?? 10 },
      withTotal: over.withTotal ?? true,
    });

    it('pages the customer’s reviews of this Market with status and moderation state, no text', async () => {
      const { facade } = setUp();
      const page = await facade.adminCustomerReviews(admin(), { ...request(), statuses: null });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      expect(page.value.total).toBe(3);
      expect(page.value.rows.map((r) => r.status)).toEqual(['held', 'hidden', 'published']);
      expect(page.value.rows[1]).toEqual({
        reviewId: id(0x102),
        productId: id(0x202),
        offerId: id(0x302),
        sellerId: id(0x400),
        rating: 2,
        anonymous: true,
        status: 'hidden',
        createdAt: at(2).toString(),
        editedAt: null,
        publishedAt: null,
        helpfulCount: 4,
        openReports: 1,
        lastModeration: {
          action: 'hide',
          reasonCode: 'abusive',
          byModerator: true,
          at: at(3).toString(),
        },
      });
      expect(JSON.stringify(page.value)).not.toMatch(/title|body/);
      const hidden = await facade.adminCustomerReviews(admin(), {
        ...request({ withTotal: false, direction: 'asc', limit: 1 }),
        statuses: ['hidden', 'published'],
      });
      expect(hidden).toMatchObject({
        ok: true,
        value: { total: null, rows: [{ status: 'published' }] },
      });
      const unknown = await facade.adminCustomerReviews(admin(), {
        ...request(),
        statuses: ['visible'],
      });
      expect(unknown).toEqual({ ok: true, value: { total: 0, rows: [] } });
    });

    it('pages the ratings, the votes and the reports of the customer', async () => {
      const { facade, reader } = setUp();
      reader.ratings.push({
        market: market.marketId,
        accountId: CUSTOMER,
        row: {
          id: id<'SellerRating'>(0x501),
          sellerId: id<'Seller'>(0x400),
          sellerOrderId: id<'SellerOrder'>(0x601),
          satisfaction: 2,
          asDescribed: true,
          arrivedOk: false,
          reasonCode: 'damaged',
          status: 'published',
          createdAt: at(1),
        },
      });
      reader.votes.push({
        market: market.marketId,
        accountId: CUSTOMER,
        row: {
          reviewId: id<'ProductReview'>(0x105),
          productId: id<'Product'>(0x205),
          votedAt: at(2),
        },
      });
      for (const [n, role] of [
        [1, 'by'],
        [2, 'about'],
      ] as const) {
        reader.reports.push({
          market: market.marketId,
          accountId: CUSTOMER,
          row: {
            id: id<'ReviewReport'>(0x700 + n),
            reviewId: id<'ProductReview'>(0x100 + n),
            role,
            reasonCode: 'off-topic',
            status: 'open',
            createdAt: at(n),
          },
        });
      }
      await expect(
        facade.adminCustomerSellerRatings(admin(), { ...request(), statuses: ['published'] }),
      ).resolves.toEqual({
        ok: true,
        value: {
          total: 1,
          rows: [
            {
              ratingId: id(0x501),
              sellerId: id(0x400),
              sellerOrderId: id(0x601),
              satisfaction: 2,
              asDescribed: true,
              arrivedOk: false,
              reasonCode: 'damaged',
              status: 'published',
              createdAt: at(1).toString(),
            },
          ],
        },
      });
      await expect(facade.adminCustomerHelpfulVotes(admin(), request())).resolves.toEqual({
        ok: true,
        value: {
          total: 1,
          rows: [{ reviewId: id(0x105), productId: id(0x205), votedAt: at(2).toString() }],
        },
      });
      await expect(
        facade.adminCustomerReviewReports(admin(), { ...request(), roles: null }),
      ).resolves.toMatchObject({
        ok: true,
        value: { total: 2, rows: [{ role: 'about' }, { role: 'by' }] },
      });
      await expect(
        facade.adminCustomerReviewReports(admin(), { ...request(), roles: ['by'] }),
      ).resolves.toMatchObject({ ok: true, value: { total: 1, rows: [{ reportId: id(0x701) }] } });
    });

    it('caps the window at 10,001 rows and never reads before the first row', async () => {
      const { facade, reader } = setUp();
      await facade.adminCustomerHelpfulVotes(admin(), {
        ...request(),
        window: { offset: -5, limit: 50_000 },
      });
      expect(reader.windows).toEqual([{ direction: 'desc', offset: 0, limit: 10_001 }]);
    });

    it('refuses everyone but a platform admin: a seller, a seller-scoped admin, acting-as', async () => {
      const { facade, reader } = setUp();
      const acting = admin();
      for (const context of [
        testCallContext(market, 'system'),
        actor('customer', null),
        actor('seller', id<'Seller'>(0x400)),
        // The kernel never mints one; the flow refuses it anyway (defence in depth).
        { ...acting, actor: { ...acting.actor, sellerId: id<'Seller'>(0x400) } as never },
        { ...acting, actor: { ...acting.actor, actingAs: { sellerId: 'x' } } as never },
      ]) {
        for (const read of [
          facade.adminCustomerReviews(context, { ...request(), statuses: null }),
          facade.adminCustomerSellerRatings(context, { ...request(), statuses: null }),
          facade.adminCustomerHelpfulVotes(context, request()),
          facade.adminCustomerReviewReports(context, { ...request(), roles: null }),
        ]) {
          await expect(read).resolves.toMatchObject({
            ok: false,
            error: { code: 'access.denied' },
          });
        }
      }
      expect(reader.windows).toEqual([]);
    });

    it('names a review’s author to the system only; nobody for an unknown or detached review', async () => {
      const { facade, reader } = setUp();
      const system = testCallContext(market, 'system');
      reader.authors.set(`${market.marketId}|${id(0x101)}`, CUSTOMER);
      reader.authors.set(`${market.marketId}|${id(0x102)}`, null);
      reader.authors.set(`${elsewhere.marketId}|${id(0x103)}`, OTHER);
      await expect(facade.reviewAuthorOf(system, id(0x101))).resolves.toEqual({
        ok: true,
        value: { accountId: CUSTOMER },
      });
      for (const reviewId of [id(0x102), id(0x103), id(0x999)]) {
        await expect(facade.reviewAuthorOf(system, reviewId)).resolves.toEqual({
          ok: true,
          value: { accountId: null },
        });
      }
      await expect(facade.reviewAuthorOf(system, 'not-an-id')).resolves.toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      for (const context of [admin(), actor('seller', id<'Seller'>(0x400))]) {
        await expect(facade.reviewAuthorOf(context, id(0x101))).resolves.toMatchObject({
          ok: false,
          error: { code: 'access.denied' },
        });
      }
    });

    it('declares the reviews key on the four reads and the system rule on the lookup', () => {
      for (const type of [
        AdminCustomerReviews,
        AdminCustomerSellerRatings,
        AdminCustomerHelpfulVotes,
        AdminCustomerReviewReports,
      ]) {
        expect(type.access.rule).toEqual({
          kind: 'permissions',
          allOf: ['reviews.customer-review.view'],
        });
      }
      expect(ReviewAuthorOf.access.rule).toEqual({ kind: 'system' });
    });
  },
);
