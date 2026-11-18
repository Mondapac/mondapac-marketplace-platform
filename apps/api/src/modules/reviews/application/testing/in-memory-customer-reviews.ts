import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { ReviewReportRole } from '../../contracts/customer-reviews.facade';
import type { ReviewStatus, SellerRatingStatus } from '../../domain/rules';
import type {
  AccountHelpfulVoteRow,
  AccountReportRow,
  AccountReviewRow,
  AccountSellerRatingRow,
  AccountWindow,
  CustomerReviewsReader,
} from '../ports/customer-reviews.reader';

// The admin's reads of one customer's reviews (customers management phase 2b, part 3) in memory,
// for the unit and HTTP tests: rows per Market and account, cut to the window in the order asked.

export type Keyed<R> = {
  readonly market: string;
  readonly accountId: Id<'Account'>;
  readonly row: R;
};

/** The reader in memory: rows per Market and account, cut to the window in the order asked. */
export class MemoryCustomerReviews implements CustomerReviewsReader {
  readonly reviews: Keyed<AccountReviewRow>[] = [];
  readonly ratings: Keyed<AccountSellerRatingRow>[] = [];
  readonly votes: Keyed<AccountHelpfulVoteRow>[] = [];
  readonly reports: Keyed<AccountReportRow>[] = [];
  readonly authors = new Map<string, Id<'Account'> | null>();
  readonly windows: AccountWindow[] = [];

  #cut<R>(rows: readonly R[], at: (row: R) => Temporal.Instant, window: AccountWindow) {
    this.windows.push(window);
    const sorted = [...rows].sort((a, b) => Temporal.Instant.compare(at(a), at(b)));
    if (window.direction === 'desc') sorted.reverse();
    return sorted.slice(window.offset, window.offset + window.limit);
  }

  #of<R>(store: Keyed<R>[], market: MarketContext, accountId: Id<'Account'>) {
    return store
      .filter((e) => e.market === market.marketId && e.accountId === accountId)
      .map((e) => e.row);
  }

  #reviews(m: MarketContext, a: Id<'Account'>, statuses: readonly ReviewStatus[] | null) {
    return this.#of(this.reviews, m, a).filter((r) => statuses?.includes(r.status) ?? true);
  }
  reviewsOf(
    m: MarketContext,
    a: Id<'Account'>,
    s: readonly ReviewStatus[] | null,
    w: AccountWindow,
  ) {
    return Promise.resolve(this.#cut(this.#reviews(m, a, s), (r) => r.createdAt, w));
  }
  countReviewsOf(m: MarketContext, a: Id<'Account'>, s: readonly ReviewStatus[] | null) {
    return Promise.resolve(this.#reviews(m, a, s).length);
  }

  #ratings(m: MarketContext, a: Id<'Account'>, statuses: readonly SellerRatingStatus[] | null) {
    return this.#of(this.ratings, m, a).filter((r) => statuses?.includes(r.status) ?? true);
  }
  sellerRatingsOf(
    m: MarketContext,
    a: Id<'Account'>,
    s: readonly SellerRatingStatus[] | null,
    w: AccountWindow,
  ) {
    return Promise.resolve(this.#cut(this.#ratings(m, a, s), (r) => r.createdAt, w));
  }
  countSellerRatingsOf(
    m: MarketContext,
    a: Id<'Account'>,
    s: readonly SellerRatingStatus[] | null,
  ) {
    return Promise.resolve(this.#ratings(m, a, s).length);
  }

  helpfulVotesOf(m: MarketContext, a: Id<'Account'>, w: AccountWindow) {
    return Promise.resolve(this.#cut(this.#of(this.votes, m, a), (r) => r.votedAt, w));
  }
  countHelpfulVotesOf(m: MarketContext, a: Id<'Account'>) {
    return Promise.resolve(this.#of(this.votes, m, a).length);
  }

  #reports(m: MarketContext, a: Id<'Account'>, roles: readonly ReviewReportRole[] | null) {
    return this.#of(this.reports, m, a).filter((r) => roles?.includes(r.role) ?? true);
  }
  reportsOf(
    m: MarketContext,
    a: Id<'Account'>,
    roles: readonly ReviewReportRole[] | null,
    w: AccountWindow,
  ) {
    return Promise.resolve(this.#cut(this.#reports(m, a, roles), (r) => r.createdAt, w));
  }
  countReportsOf(m: MarketContext, a: Id<'Account'>, roles: readonly ReviewReportRole[] | null) {
    return Promise.resolve(this.#reports(m, a, roles).length);
  }

  authorOf(m: MarketContext, reviewId: Id<'ProductReview'>) {
    const key = `${m.marketId}|${reviewId}`;
    return Promise.resolve(this.authors.has(key) ? this.authors.get(key)! : undefined);
  }
}
