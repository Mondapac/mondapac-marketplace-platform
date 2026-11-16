import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { ReviewReportRole } from '../contracts/customer-reviews.facade';
import type {
  AccountReportRow,
  AccountWindow,
  CustomerReviewsReader,
} from '../application/ports/customer-reviews.reader';
import type { ModerationActionName } from '../application/ports/review.repository';
import type { ReviewStatus, SellerRatingReason, SellerRatingStatus } from '../domain/rules';

const fromDate = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const fromNullable = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : fromDate(date);

/** A closed filter: null is every value, an empty list matches nothing. */
const among = <T extends string>(values: readonly T[] | null) =>
  values === null ? {} : { in: [...values] };

/**
 * The reports the roles cover: `by` the account made them; `about` they report one of the
 * account's reviews and someone else made them (a NULL reporter is someone else).
 */
function reportWhere(accountId: Id<'Account'>, roles: readonly ReviewReportRole[] | null) {
  const by = { reporterAccountId: accountId };
  const about = {
    review: { accountId },
    OR: [{ reporterAccountId: null }, { reporterAccountId: { not: accountId } }],
  };
  const wanted = roles ?? ['by', 'about'];
  const parts = [
    ...(wanted.includes('by') ? [by] : []),
    ...(wanted.includes('about') ? [about] : []),
  ];
  return parts.length === 0 ? { id: { in: [] as string[] } } : { OR: parts };
}

/**
 * {@link CustomerReviewsReader} on the `reviews` schema, scoped by `marketId`: the reviews and
 * ratings through their (market, account, created) indexes, the votes through (market, account,
 * created), the reports by the account through (market, reporter, created) and the reports about
 * it through the reviews' index and the reports' (market, review, reporter) key.
 */
export class PrismaCustomerReviewsReader implements CustomerReviewsReader {
  constructor(private readonly prisma: PrismaService) {}

  async reviewsOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    statuses: readonly ReviewStatus[] | null,
    window: AccountWindow,
  ) {
    const rows = await this.prisma.tx(market).reviewsProductReview.findMany({
      where: { marketId: market.marketId, accountId, status: among(statuses) },
      orderBy: [{ createdAt: window.direction }, { id: window.direction }],
      skip: window.offset,
      take: window.limit,
      select: {
        id: true,
        productId: true,
        offerId: true,
        sellerId: true,
        rating: true,
        anonymous: true,
        status: true,
        createdAt: true,
        editedAt: true,
        publishedAt: true,
        helpfulCount: true,
        _count: { select: { reports: { where: { status: 'open' } } } },
        moderationActions: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: { action: true, reasonCode: true, actorAccountId: true, createdAt: true },
        },
      },
    });
    return rows.map((row) => {
      const last = row.moderationActions[0];
      return {
        id: row.id as Id<'ProductReview'>,
        productId: row.productId as Id<'Product'>,
        offerId: row.offerId as Id<'Offer'>,
        sellerId: row.sellerId as Id<'Seller'>,
        rating: row.rating,
        anonymous: row.anonymous,
        status: row.status as ReviewStatus,
        createdAt: fromDate(row.createdAt),
        editedAt: fromNullable(row.editedAt),
        publishedAt: fromNullable(row.publishedAt),
        helpfulCount: row.helpfulCount,
        openReports: row._count.reports,
        lastModeration:
          last === undefined
            ? null
            : {
                action: last.action as ModerationActionName,
                reasonCode: last.reasonCode,
                byModerator: last.actorAccountId !== null,
                at: fromDate(last.createdAt),
              },
      };
    });
  }

  countReviewsOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    statuses: readonly ReviewStatus[] | null,
  ) {
    return this.prisma.tx(market).reviewsProductReview.count({
      where: { marketId: market.marketId, accountId, status: among(statuses) },
    });
  }

  async sellerRatingsOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    statuses: readonly SellerRatingStatus[] | null,
    window: AccountWindow,
  ) {
    const rows = await this.prisma.tx(market).reviewsSellerRating.findMany({
      where: { marketId: market.marketId, accountId, status: among(statuses) },
      orderBy: [{ createdAt: window.direction }, { id: window.direction }],
      skip: window.offset,
      take: window.limit,
      select: {
        id: true,
        sellerId: true,
        sellerOrderId: true,
        satisfaction: true,
        asDescribed: true,
        arrivedOk: true,
        reasonCode: true,
        status: true,
        createdAt: true,
      },
    });
    return rows.map((row) => ({
      id: row.id as Id<'SellerRating'>,
      sellerId: row.sellerId as Id<'Seller'>,
      sellerOrderId: row.sellerOrderId as Id<'SellerOrder'> | null,
      satisfaction: row.satisfaction,
      asDescribed: row.asDescribed,
      arrivedOk: row.arrivedOk,
      reasonCode: row.reasonCode as SellerRatingReason | null,
      status: row.status as SellerRatingStatus,
      createdAt: fromDate(row.createdAt),
    }));
  }

  countSellerRatingsOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    statuses: readonly SellerRatingStatus[] | null,
  ) {
    return this.prisma.tx(market).reviewsSellerRating.count({
      where: { marketId: market.marketId, accountId, status: among(statuses) },
    });
  }

  async helpfulVotesOf(market: MarketContext, accountId: Id<'Account'>, window: AccountWindow) {
    const rows = await this.prisma.tx(market).reviewsHelpfulVote.findMany({
      where: { marketId: market.marketId, accountId },
      orderBy: [{ createdAt: window.direction }, { reviewId: window.direction }],
      skip: window.offset,
      take: window.limit,
      select: { reviewId: true, createdAt: true, review: { select: { productId: true } } },
    });
    return rows.map((row) => ({
      reviewId: row.reviewId as Id<'ProductReview'>,
      productId: row.review.productId as Id<'Product'>,
      votedAt: fromDate(row.createdAt),
    }));
  }

  countHelpfulVotesOf(market: MarketContext, accountId: Id<'Account'>) {
    return this.prisma.tx(market).reviewsHelpfulVote.count({
      where: { marketId: market.marketId, accountId },
    });
  }

  async reportsOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    roles: readonly ReviewReportRole[] | null,
    window: AccountWindow,
  ): Promise<readonly AccountReportRow[]> {
    const rows = await this.prisma.tx(market).reviewsReport.findMany({
      where: { marketId: market.marketId, ...reportWhere(accountId, roles) },
      orderBy: [{ createdAt: window.direction }, { id: window.direction }],
      skip: window.offset,
      take: window.limit,
      select: {
        id: true,
        reviewId: true,
        reporterAccountId: true,
        reasonCode: true,
        status: true,
        createdAt: true,
      },
    });
    // The reporter's account decides the role and goes no further.
    return rows.map((row) => ({
      id: row.id as Id<'ReviewReport'>,
      reviewId: row.reviewId as Id<'ProductReview'>,
      role: row.reporterAccountId === accountId ? ('by' as const) : ('about' as const),
      reasonCode: row.reasonCode,
      status: row.status,
      createdAt: fromDate(row.createdAt),
    }));
  }

  countReportsOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    roles: readonly ReviewReportRole[] | null,
  ) {
    return this.prisma.tx(market).reviewsReport.count({
      where: { marketId: market.marketId, ...reportWhere(accountId, roles) },
    });
  }

  async authorOf(market: MarketContext, reviewId: Id<'ProductReview'>) {
    const row = await this.prisma.tx(market).reviewsProductReview.findFirst({
      where: { marketId: market.marketId, id: reviewId },
      select: { accountId: true },
    });
    return row === null ? undefined : (row.accountId as Id<'Account'> | null);
  }
}
