import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { MAX_PAGED_ROWS, parseClosedValues } from '../../../platform/list-query';
import {
  SECTION_REPORT_ROLES,
  SECTION_REVIEW_STATUSES,
  SECTION_SELLER_RATING_STATUSES,
  type SectionHelpfulVote,
  type SectionReview,
  type SectionReviewReport,
  type SectionSellerRating,
} from './ports/customer-section-peers';
import type { ListValidationFailure } from './customer-list-flow';
import type { SectionListSpec } from './customer-section-lists';

// The customer page's reviews sections (customers management phase 2b, part 3), each one facade
// read of `reviews` behind `reviews.customer-review.view`: the reviews the customer wrote with
// their status and moderation state (read only: moderating stays in the moderation queue), the
// seller ratings they gave, the helpful votes they cast and the reports by and about them. Ids,
// codes and instants only; never a review's text, a reporter or another review's author.

type NoFilters = Readonly<Record<string, never>>;

const query = <S extends string>(sort: S) => ({
  sorts: [sort] as const,
  defaultSort: sort,
  defaultPageSize: 25,
  maxPageSize: 100,
  maxPage: Math.ceil(MAX_PAGED_ROWS / 25),
});

interface StatusFilters {
  readonly statuses: readonly string[] | null;
}

const statusFilter =
  (allowed: readonly string[]) =>
  (raw: Readonly<Record<string, unknown>>): Result<StatusFilters, ListValidationFailure> => {
    const statuses = parseClosedValues(raw['status'], allowed, 'filters.status');
    return statuses.ok ? ok({ statuses: statuses.value }) : statuses;
  };

/** The reviews the customer wrote (any status), newest first. */
export const REVIEWS_SECTION: SectionListSpec<StatusFilters, 'created', SectionReview> = {
  section: 'reviews',
  filterKeys: ['status'],
  parseFilters: statusFilter(SECTION_REVIEW_STATUSES),
  query: query('created'),
  read: (peers, context, request) =>
    peers.reviews.adminCustomerReviews(context, {
      accountId: request.accountId,
      statuses: request.filters.statuses,
      direction: request.direction,
      window: request.window,
      withTotal: request.withTotal,
    }),
  sheet: {
    baseName: 'customer-reviews',
    name: 'Reviews',
    header: [
      'Review',
      'Product',
      'Offer',
      'Seller',
      'Rating',
      'Anonymous',
      'Status',
      'Created at',
      'Edited at',
      'Published at',
      'Helpful votes',
      'Open reports',
      'Last moderation',
      'Last moderation reason',
      'Last moderation by moderator',
      'Last moderation at',
    ],
    cells: (row) => [
      row.reviewId,
      row.productId,
      row.offerId,
      row.sellerId,
      row.rating,
      row.anonymous ? 'yes' : 'no',
      row.status,
      row.createdAt,
      row.editedAt,
      row.publishedAt,
      row.helpfulCount,
      row.openReports,
      row.lastModeration?.action ?? null,
      row.lastModeration?.reasonCode ?? null,
      row.lastModeration === null ? null : row.lastModeration.byModerator ? 'yes' : 'no',
      row.lastModeration?.at ?? null,
    ],
  },
};

/** The seller ratings the customer gave, newest first. */
export const SELLER_RATINGS_SECTION: SectionListSpec<
  StatusFilters,
  'created',
  SectionSellerRating
> = {
  section: 'seller-ratings',
  filterKeys: ['status'],
  parseFilters: statusFilter(SECTION_SELLER_RATING_STATUSES),
  query: query('created'),
  read: (peers, context, request) =>
    peers.reviews.adminCustomerSellerRatings(context, {
      accountId: request.accountId,
      statuses: request.filters.statuses,
      direction: request.direction,
      window: request.window,
      withTotal: request.withTotal,
    }),
  sheet: {
    baseName: 'customer-seller-ratings',
    name: 'Seller ratings',
    header: [
      'Rating',
      'Seller',
      'Seller order',
      'Satisfaction',
      'As described',
      'Arrived OK',
      'Reason',
      'Status',
      'Created at',
    ],
    cells: (row) => [
      row.ratingId,
      row.sellerId,
      row.sellerOrderId,
      row.satisfaction,
      row.asDescribed ? 'yes' : 'no',
      row.arrivedOk ? 'yes' : 'no',
      row.reasonCode,
      row.status,
      row.createdAt,
    ],
  },
};

/** The helpful votes the customer cast: the review voted for, never its author. */
export const HELPFUL_VOTES_SECTION: SectionListSpec<NoFilters, 'voted', SectionHelpfulVote> = {
  section: 'helpful-votes',
  filterKeys: [],
  parseFilters: () => ok({}),
  query: query('voted'),
  read: (peers, context, request) =>
    peers.reviews.adminCustomerHelpfulVotes(context, {
      accountId: request.accountId,
      direction: request.direction,
      window: request.window,
      withTotal: request.withTotal,
    }),
  sheet: {
    baseName: 'customer-helpful-votes',
    name: 'Helpful votes',
    header: ['Review', 'Product', 'Voted at'],
    cells: (row) => [row.reviewId, row.productId, row.votedAt],
  },
};

interface RoleFilters {
  readonly roles: readonly (typeof SECTION_REPORT_ROLES)[number][] | null;
}

/** The reports made by the customer (`by`) and about the customer's reviews (`about`). */
export const REVIEW_REPORTS_SECTION: SectionListSpec<RoleFilters, 'created', SectionReviewReport> =
  {
    section: 'review-reports',
    filterKeys: ['role'],
    parseFilters: (raw) => {
      const roles = parseClosedValues(raw['role'], SECTION_REPORT_ROLES, 'filters.role');
      return roles.ok ? ok({ roles: roles.value }) : roles;
    },
    query: query('created'),
    read: (peers, context, request) =>
      peers.reviews.adminCustomerReviewReports(context, {
        accountId: request.accountId,
        roles: request.filters.roles,
        direction: request.direction,
        window: request.window,
        withTotal: request.withTotal,
      }),
    sheet: {
      baseName: 'customer-review-reports',
      name: 'Review reports',
      header: ['Report', 'Review', 'Role', 'Reason', 'Status', 'Created at'],
      cells: (row) => [
        row.reportId,
        row.reviewId,
        row.role,
        row.reasonCode,
        row.status,
        row.createdAt,
      ],
    },
  };
