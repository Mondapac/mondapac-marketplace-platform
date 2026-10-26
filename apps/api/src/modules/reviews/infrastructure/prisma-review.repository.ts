import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  NewModerationAction,
  NewSignal,
  ProductReviewRecord,
  ReviewCursor,
  ReviewRepository,
  SellerRatingRecord,
  StoredSellerSummary,
  StoredStarSummary,
} from '../application/ports/review.repository';
import type { ReviewStatus, SellerRatingReason, SellerRatingStatus } from '../domain/rules';
import {
  summariseSellerGroups,
  summariseStarGroups,
  type SellerSummary,
  type StarSummary,
} from '../domain/summary';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const fromDate = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const fromNullable = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : fromDate(date);

interface ReviewRow {
  readonly id: string;
  readonly accountId: string | null;
  readonly productId: string;
  readonly offerId: string;
  readonly sellerId: string;
  readonly lastSellerOrderId: string;
  readonly rating: number;
  readonly title: string | null;
  readonly body: string | null;
  readonly locale: string;
  readonly anonymous: boolean;
  readonly status: string;
  readonly createdAt: Date;
  readonly editedAt: Date | null;
  readonly publishedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly lastPurchaseAt: Date;
}

const toReview = (row: ReviewRow): ProductReviewRecord => ({
  id: row.id as Id<'ProductReview'>,
  accountId: row.accountId as Id<'Account'> | null,
  productId: row.productId as Id<'Product'>,
  offerId: row.offerId as Id<'Offer'>,
  sellerId: row.sellerId as Id<'Seller'>,
  lastSellerOrderId: row.lastSellerOrderId as Id<'SellerOrder'>,
  rating: row.rating,
  title: row.title,
  body: row.body,
  locale: row.locale,
  anonymous: row.anonymous,
  status: row.status as ReviewStatus,
  createdAt: fromDate(row.createdAt),
  editedAt: fromNullable(row.editedAt),
  publishedAt: fromNullable(row.publishedAt),
  deletedAt: fromNullable(row.deletedAt),
  lastPurchaseAt: fromDate(row.lastPurchaseAt),
});

const reviewColumns = (record: ProductReviewRecord) => ({
  accountId: record.accountId,
  offerId: record.offerId,
  sellerId: record.sellerId,
  lastSellerOrderId: record.lastSellerOrderId,
  rating: record.rating,
  title: record.title,
  body: record.body,
  locale: record.locale,
  anonymous: record.anonymous,
  status: record.status,
  createdAt: toDate(record.createdAt),
  editedAt: record.editedAt === null ? null : toDate(record.editedAt),
  publishedAt: record.publishedAt === null ? null : toDate(record.publishedAt),
  deletedAt: record.deletedAt === null ? null : toDate(record.deletedAt),
  lastPurchaseAt: toDate(record.lastPurchaseAt),
});

const toRating = (row: {
  readonly id: string;
  readonly accountId: string | null;
  readonly sellerOrderId: string;
  readonly sellerId: string;
  readonly satisfaction: number;
  readonly asDescribed: boolean;
  readonly arrivedOk: boolean;
  readonly reasonCode: string | null;
  readonly status: string;
  readonly createdAt: Date;
}): SellerRatingRecord => ({
  id: row.id as Id<'SellerRating'>,
  accountId: row.accountId as Id<'Account'> | null,
  sellerOrderId: row.sellerOrderId as Id<'SellerOrder'>,
  sellerId: row.sellerId as Id<'Seller'>,
  satisfaction: row.satisfaction,
  asDescribed: row.asDescribed,
  arrivedOk: row.arrivedOk,
  reasonCode: row.reasonCode as SellerRatingReason | null,
  status: row.status as SellerRatingStatus,
  createdAt: fromDate(row.createdAt),
});

/** The columns of one stored summary row. */
const summaryColumns = (
  summary: StarSummary,
  seller: SellerSummary | null,
  now: Temporal.Instant,
) => ({
  count: summary.count,
  sum: summary.sum,
  histogram1: summary.histogram[0],
  histogram2: summary.histogram[1],
  histogram3: summary.histogram[2],
  histogram4: summary.histogram[3],
  histogram5: summary.histogram[4],
  ratedSellerOrders: seller?.ratedSellerOrders ?? 0,
  satisfiedCount: seller?.satisfiedCount ?? 0,
  asDescribedYes: seller?.asDescribedYes ?? 0,
  arrivedOkYes: seller?.arrivedOkYes ?? 0,
  rebuiltAt: toDate(now),
});

const starsOf = (row: {
  readonly count: number;
  readonly sum: number;
  readonly histogram1: number;
  readonly histogram2: number;
  readonly histogram3: number;
  readonly histogram4: number;
  readonly histogram5: number;
}): StarSummary => ({
  count: row.count,
  sum: row.sum,
  histogram: [row.histogram1, row.histogram2, row.histogram3, row.histogram4, row.histogram5],
});

/** {@link ReviewRepository} on the `reviews` schema, scoped by `marketId`. */
export class PrismaReviewRepository implements ReviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- product reviews ----------------------------------------------------------------------

  async findOwnProductReview(
    market: MarketContext,
    accountId: Id<'Account'>,
    productId: Id<'Product'>,
  ) {
    const row = await this.prisma.tx(market).reviewsProductReview.findFirst({
      where: { marketId: market.marketId, accountId, productId },
    });
    return row === null ? null : toReview(row);
  }

  async findOwnProductReviewById(
    market: MarketContext,
    accountId: Id<'Account'>,
    reviewId: Id<'ProductReview'>,
  ) {
    const row = await this.prisma.tx(market).reviewsProductReview.findFirst({
      where: { marketId: market.marketId, accountId, id: reviewId },
    });
    return row === null ? null : toReview(row);
  }

  async insertProductReviewIfAbsent(market: MarketContext, record: ProductReviewRecord) {
    const created = await this.prisma.tx(market).reviewsProductReview.createMany({
      data: [
        {
          id: record.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          productId: record.productId,
          ...reviewColumns(record),
        },
      ],
      skipDuplicates: true,
    });
    return created.count > 0;
  }

  async saveProductReview(
    market: MarketContext,
    record: ProductReviewRecord,
    expectedStatus: ReviewStatus,
  ) {
    const updated = await this.prisma.tx(market).reviewsProductReview.updateMany({
      where: { marketId: market.marketId, id: record.id, status: expectedStatus },
      data: reviewColumns(record),
    });
    return updated.count === 0 ? ('stale' as const) : ('saved' as const);
  }

  async countSubmissionsSince(
    market: MarketContext,
    accountId: Id<'Account'>,
    since: Temporal.Instant,
  ) {
    const tx = this.prisma.tx(market);
    const [reviews, ratings] = await Promise.all([
      tx.reviewsProductReview.count({
        where: { marketId: market.marketId, accountId, createdAt: { gte: toDate(since) } },
      }),
      tx.reviewsSellerRating.count({
        where: { marketId: market.marketId, accountId, createdAt: { gte: toDate(since) } },
      }),
    ]);
    return reviews + ratings;
  }

  async listOwnProductReviews(market: MarketContext, accountId: Id<'Account'>, limit: number) {
    const rows = await this.prisma.tx(market).reviewsProductReview.findMany({
      where: {
        marketId: market.marketId,
        accountId,
        status: { not: 'deleted-by-author' },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map(toReview);
  }

  async reviewedProductIds(
    market: MarketContext,
    accountId: Id<'Account'>,
    productIds: readonly Id<'Product'>[],
  ) {
    if (productIds.length === 0) return new Set<Id<'Product'>>();
    const rows = await this.prisma.tx(market).reviewsProductReview.findMany({
      where: {
        marketId: market.marketId,
        accountId,
        productId: { in: [...productIds] },
        status: { not: 'deleted-by-author' },
      },
      select: { productId: true },
    });
    return new Set(rows.map((row) => row.productId as Id<'Product'>));
  }

  async listPublishedProductReviews(
    market: MarketContext,
    productId: Id<'Product'>,
    query: {
      readonly stars: number | null;
      readonly after: ReviewCursor | null;
      readonly limit: number;
    },
  ) {
    const rows = await this.prisma.tx(market).reviewsProductReview.findMany({
      where: {
        marketId: market.marketId,
        productId,
        status: 'published',
        ...(query.stars === null ? {} : { rating: query.stars }),
        ...(query.after === null
          ? {}
          : {
              OR: [
                { publishedAt: { lt: toDate(query.after.publishedAt) } },
                { publishedAt: toDate(query.after.publishedAt), id: { lt: query.after.id } },
              ],
            }),
      },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
    });
    return rows.map(toReview);
  }

  // ---- seller ratings -----------------------------------------------------------------------

  async insertSellerRatingIfAbsent(market: MarketContext, record: SellerRatingRecord) {
    const created = await this.prisma.tx(market).reviewsSellerRating.createMany({
      data: [
        {
          id: record.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          accountId: record.accountId,
          sellerOrderId: record.sellerOrderId,
          sellerId: record.sellerId,
          satisfaction: record.satisfaction,
          asDescribed: record.asDescribed,
          arrivedOk: record.arrivedOk,
          reasonCode: record.reasonCode,
          status: record.status,
          createdAt: toDate(record.createdAt),
        },
      ],
      skipDuplicates: true,
    });
    return created.count > 0;
  }

  async listOwnSellerRatings(market: MarketContext, accountId: Id<'Account'>, limit: number) {
    const rows = await this.prisma.tx(market).reviewsSellerRating.findMany({
      where: { marketId: market.marketId, accountId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map(toRating);
  }

  async ratedSellerOrderIds(
    market: MarketContext,
    accountId: Id<'Account'>,
    sellerOrderIds: readonly Id<'SellerOrder'>[],
  ) {
    if (sellerOrderIds.length === 0) return new Set<Id<'SellerOrder'>>();
    const rows = await this.prisma.tx(market).reviewsSellerRating.findMany({
      where: {
        marketId: market.marketId,
        accountId,
        sellerOrderId: { in: [...sellerOrderIds] },
      },
      select: { sellerOrderId: true },
    });
    return new Set(rows.map((row) => row.sellerOrderId as Id<'SellerOrder'>));
  }

  // ---- the log and the signals --------------------------------------------------------------

  async appendModerationAction(market: MarketContext, action: NewModerationAction) {
    await this.prisma.tx(market).reviewsModerationAction.create({
      data: {
        id: action.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        reviewId: action.reviewId,
        actorAccountId: action.actorAccountId,
        action: action.action,
        reasonCode: action.reasonCode,
        fromStatus: action.fromStatus,
        toStatus: action.toStatus,
        createdAt: toDate(action.at),
      },
    });
  }

  async appendSignals(market: MarketContext, signals: readonly NewSignal[]) {
    if (signals.length === 0) return;
    await this.prisma.tx(market).reviewsSignal.createMany({
      data: signals.map((signal) => ({
        id: signal.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        subjectKind: signal.subject,
        subjectId: signal.subjectId,
        code: signal.code,
        at: toDate(signal.at),
      })),
    });
  }

  // ---- summaries ----------------------------------------------------------------------------

  async readProductSummary(
    market: MarketContext,
    productId: Id<'Product'>,
  ): Promise<StoredStarSummary | null> {
    const row = await this.prisma.tx(market).reviewsRatingSummary.findFirst({
      where: { marketId: market.marketId, subjectKind: 'product', subjectId: productId },
    });
    return row === null ? null : { ...starsOf(row), rebuiltAt: fromDate(row.rebuiltAt) };
  }

  async readSellerSummary(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<StoredSellerSummary | null> {
    const row = await this.prisma.tx(market).reviewsRatingSummary.findFirst({
      where: { marketId: market.marketId, subjectKind: 'seller', subjectId: sellerId },
    });
    return row === null
      ? null
      : {
          ...starsOf(row),
          ratedSellerOrders: row.ratedSellerOrders,
          satisfiedCount: row.satisfiedCount,
          asDescribedYes: row.asDescribedYes,
          arrivedOkYes: row.arrivedOkYes,
          rebuiltAt: fromDate(row.rebuiltAt),
        };
  }

  async rebuildSummaries(
    market: MarketContext,
    subjects: {
      readonly products: readonly Id<'Product'>[];
      readonly sellers: readonly Id<'Seller'>[];
    },
    now: Temporal.Instant,
  ) {
    const products = [...new Set(subjects.products)];
    const sellers = [...new Set(subjects.sellers)];
    if (products.length > 0) {
      const groups = await this.productGroups(market, products);
      for (const productId of products) {
        await this.writeSummary(
          market,
          'product',
          productId,
          summariseStarGroups(groups.get(productId) ?? []),
          null,
          now,
        );
      }
    }
    if (sellers.length > 0) {
      const groups = await this.sellerGroups(market, sellers);
      for (const sellerId of sellers) {
        const summary = summariseSellerGroups(groups.get(sellerId) ?? []);
        await this.writeSummary(market, 'seller', sellerId, summary, summary, now);
      }
    }
  }

  async rebuildAllSummaries(market: MarketContext, now: Temporal.Instant) {
    const tx = this.prisma.tx(market);
    const stored = await tx.reviewsRatingSummary.findMany({
      where: { marketId: market.marketId },
      select: { subjectKind: true, subjectId: true },
    });
    const productGroups = await this.productGroups(market, null);
    const sellerGroups = await this.sellerGroups(market, null);
    const products = new Set<string>(productGroups.keys());
    const sellers = new Set<string>(sellerGroups.keys());
    for (const row of stored) {
      (row.subjectKind === 'product' ? products : sellers).add(row.subjectId);
    }
    for (const productId of products) {
      await this.writeSummary(
        market,
        'product',
        productId,
        summariseStarGroups(productGroups.get(productId) ?? []),
        null,
        now,
      );
    }
    for (const sellerId of sellers) {
      const summary = summariseSellerGroups(sellerGroups.get(sellerId) ?? []);
      await this.writeSummary(market, 'seller', sellerId, summary, summary, now);
    }
    return products.size + sellers.size;
  }

  private async productGroups(market: MarketContext, productIds: readonly string[] | null) {
    const rows = await this.prisma.tx(market).reviewsProductReview.groupBy({
      by: ['productId', 'rating'],
      where: {
        marketId: market.marketId,
        status: 'published',
        ...(productIds === null ? {} : { productId: { in: [...productIds] } }),
      },
      _count: { _all: true },
    });
    const byProduct = new Map<string, { rating: number; count: number }[]>();
    for (const row of rows) {
      const list = byProduct.get(row.productId) ?? [];
      list.push({ rating: row.rating, count: row._count._all });
      byProduct.set(row.productId, list);
    }
    return byProduct;
  }

  private async sellerGroups(market: MarketContext, sellerIds: readonly string[] | null) {
    const rows = await this.prisma.tx(market).reviewsSellerRating.groupBy({
      by: ['sellerId', 'satisfaction', 'asDescribed', 'arrivedOk'],
      where: {
        marketId: market.marketId,
        status: 'published',
        ...(sellerIds === null ? {} : { sellerId: { in: [...sellerIds] } }),
      },
      _count: { _all: true },
    });
    const bySeller = new Map<
      string,
      { satisfaction: number; asDescribed: boolean; arrivedOk: boolean; count: number }[]
    >();
    for (const row of rows) {
      const list = bySeller.get(row.sellerId) ?? [];
      list.push({
        satisfaction: row.satisfaction,
        asDescribed: row.asDescribed,
        arrivedOk: row.arrivedOk,
        count: row._count._all,
      });
      bySeller.set(row.sellerId, list);
    }
    return bySeller;
  }

  /** Insert-or-change of one summary row: the insert loses quietly to a concurrent one. */
  private async writeSummary(
    market: MarketContext,
    kind: 'product' | 'seller',
    subjectId: string,
    stars: StarSummary,
    seller: SellerSummary | null,
    now: Temporal.Instant,
  ) {
    const tx = this.prisma.tx(market);
    const columns = summaryColumns(stars, seller, now);
    await tx.reviewsRatingSummary.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          subjectKind: kind,
          subjectId,
          ...columns,
        },
      ],
      skipDuplicates: true,
    });
    await tx.reviewsRatingSummary.updateMany({
      where: { marketId: market.marketId, subjectKind: kind, subjectId },
      data: columns,
    });
  }

  // ---- account deletion ---------------------------------------------------------------------

  async detachAccount(market: MarketContext, accountId: Id<'Account'>) {
    const tx = this.prisma.tx(market);
    const reviews = await tx.reviewsProductReview.updateMany({
      where: { marketId: market.marketId, accountId },
      data: { accountId: null },
    });
    const ratings = await tx.reviewsSellerRating.updateMany({
      where: { marketId: market.marketId, accountId },
      data: { accountId: null },
    });
    return { reviews: reviews.count, ratings: ratings.count };
  }
}
