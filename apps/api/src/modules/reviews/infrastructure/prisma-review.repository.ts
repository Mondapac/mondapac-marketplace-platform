import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  NewModerationAction,
  NewReportRecord,
  ReplyRecord,
  HistoryRow,
  ModerationDetailRecord,
  NewSignal,
  ProductReviewRecord,
  QueueCursor,
  QueueRow,
  ReviewCursor,
  ReviewRepository,
  SellerRatingRecord,
  StoredSellerSummary,
  StoredStarSummary,
} from '../application/ports/review.repository';
import type { QueueTab } from '../domain/moderation';
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
  readonly lastSellerOrderId: string | null;
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
  lastSellerOrderId: row.lastSellerOrderId as Id<'SellerOrder'> | null,
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
  readonly sellerOrderId: string | null;
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
  sellerOrderId: row.sellerOrderId as Id<'SellerOrder'> | null,
  sellerId: row.sellerId as Id<'Seller'>,
  satisfaction: row.satisfaction,
  asDescribed: row.asDescribed,
  arrivedOk: row.arrivedOk,
  reasonCode: row.reasonCode as SellerRatingReason | null,
  status: row.status as SellerRatingStatus,
  createdAt: fromDate(row.createdAt),
});

const toReply = (
  row: {
    readonly id: string;
    readonly reviewId: string;
    readonly sellerId: string;
    readonly body: string;
    readonly status: string;
    readonly createdAt: Date;
    readonly editedAt: Date | null;
  } | null,
): ReplyRecord | null =>
  row === null
    ? null
    : {
        id: row.id as Id<'ReviewReply'>,
        reviewId: row.reviewId as Id<'ProductReview'>,
        sellerId: row.sellerId as Id<'Seller'>,
        body: row.body,
        status: row.status as ReplyRecord['status'],
        createdAt: fromDate(row.createdAt),
        editedAt: row.editedAt === null ? null : fromDate(row.editedAt),
      };

/** The columns of one stored summary row. */
type SummaryRow = Awaited<ReturnType<PrismaService['tx']>>['reviewsRatingSummary'] extends {
  findMany(...args: never[]): Promise<(infer R)[]>;
}
  ? R
  : never;

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

/** The rows a queue tab lists (the status and report conditions of each tab). */
const tabWhere = (tab: QueueTab) => {
  switch (tab) {
    case 'held':
      return { status: 'held' };
    case 'reported':
      return {
        status: { in: ['published', 'held', 'hidden'] },
        reports: { some: { status: 'open' } },
      };
    case 'actioned':
      return { status: { in: ['hidden', 'removed'] } };
  }
};

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

  async lockAccount(market: MarketContext, accountId: Id<'Account'>) {
    await this.prisma.namedQuery(market, 'reviews.lock-account', { accountId });
  }

  async countSubmissionsSince(
    market: MarketContext,
    accountId: Id<'Account'>,
    since: Temporal.Instant,
  ) {
    const tx = this.prisma.tx(market);
    const [actions, ratings] = await Promise.all([
      tx.reviewsModerationAction.count({
        where: {
          marketId: market.marketId,
          createdAt: { gte: toDate(since) },
          action: { in: ['publish', 'auto-hold', 'author-edit', 'author-delete'] },
          // A moderator's own rows (publish of a held review) are not the author's writes.
          actorAccountId: null,
          review: { accountId },
        },
      }),
      tx.reviewsSellerRating.count({
        where: { marketId: market.marketId, accountId, createdAt: { gte: toDate(since) } },
      }),
    ]);
    return actions + ratings;
  }

  async listModerationQueue(
    market: MarketContext,
    query: { readonly tab: QueueTab; readonly after: QueueCursor | null; readonly limit: number },
  ): Promise<readonly QueueRow[]> {
    const tx = this.prisma.tx(market);
    const after = query.after;
    const rows = await tx.reviewsProductReview.findMany({
      where: {
        marketId: market.marketId,
        ...tabWhere(query.tab),
        ...(after === null
          ? {}
          : {
              OR: [
                { createdAt: { lt: toDate(after.createdAt) } },
                { createdAt: toDate(after.createdAt), id: { lt: after.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
    });
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const [reports, signals] = await Promise.all([
      tx.reviewsReport.groupBy({
        by: ['reviewId'],
        where: { marketId: market.marketId, reviewId: { in: ids }, status: 'open' },
        _count: { _all: true },
      }),
      tx.reviewsSignal.findMany({
        where: { marketId: market.marketId, subjectKind: 'product-review', subjectId: { in: ids } },
        select: { subjectId: true, code: true },
        orderBy: [{ at: 'asc' }, { id: 'asc' }],
      }),
    ]);
    const open = new Map(reports.map((r) => [r.reviewId, r._count._all]));
    return rows.map((row) => ({
      review: toReview(row),
      openReports: open.get(row.id) ?? 0,
      signalCodes: [...new Set(signals.filter((s) => s.subjectId === row.id).map((s) => s.code))],
    }));
  }

  async countModerationQueue(market: MarketContext) {
    const tx = this.prisma.tx(market);
    const count = (tab: QueueTab) =>
      tx.reviewsProductReview.count({ where: { marketId: market.marketId, ...tabWhere(tab) } });
    const [held, reported, actioned] = await Promise.all([
      count('held'),
      count('reported'),
      count('actioned'),
    ]);
    return { held, reported, actioned };
  }

  async findForModeration(
    market: MarketContext,
    reviewId: Id<'ProductReview'>,
  ): Promise<ModerationDetailRecord | null> {
    const tx = this.prisma.tx(market);
    const row = await tx.reviewsProductReview.findFirst({
      where: { marketId: market.marketId, id: reviewId },
    });
    if (row === null) return null;
    const [reports, signals, actions] = await Promise.all([
      tx.reviewsReport.groupBy({
        by: ['reasonCode'],
        where: { marketId: market.marketId, reviewId, status: 'open' },
        _count: { _all: true },
      }),
      tx.reviewsSignal.findMany({
        where: { marketId: market.marketId, subjectKind: 'product-review', subjectId: reviewId },
        select: { code: true },
        orderBy: [{ at: 'asc' }, { id: 'asc' }],
      }),
      tx.reviewsModerationAction.findMany({
        where: { marketId: market.marketId, reviewId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    return {
      review: toReview(row),
      openReports: reports
        .map((r) => ({ reasonCode: r.reasonCode, count: r._count._all }))
        .sort((a, b) => b.count - a.count || a.reasonCode.localeCompare(b.reasonCode)),
      signalCodes: [...new Set(signals.map((s) => s.code))],
      history: actions.map((a) => ({
        action: a.action as HistoryRow['action'],
        reasonCode: a.reasonCode,
        fromStatus: a.fromStatus as ReviewStatus | null,
        toStatus: a.toStatus as ReviewStatus,
        byModerator: a.actorAccountId !== null,
        at: fromDate(a.createdAt),
      })),
    };
  }

  async closeOpenReports(
    market: MarketContext,
    reviewId: Id<'ProductReview'>,
    status: 'actioned' | 'dismissed',
  ) {
    const result = await this.prisma.tx(market).reviewsReport.updateMany({
      where: { marketId: market.marketId, reviewId, status: 'open' },
      data: { status },
    });
    return result.count;
  }

  async wasDeletedAfterModeration(market: MarketContext, reviewId: Id<'ProductReview'>) {
    const found = await this.prisma.tx(market).reviewsModerationAction.findFirst({
      where: {
        marketId: market.marketId,
        reviewId,
        action: 'author-delete',
        fromStatus: { in: ['hidden', 'removed'] },
      },
      select: { id: true },
    });
    return found !== null;
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
    return rows.map((row) => ({ ...toReview(row), publicId: row.publicId }));
  }

  async findPublicCursor(market: MarketContext, productId: Id<'Product'>, publicId: string) {
    const row = await this.prisma.tx(market).reviewsProductReview.findFirst({
      where: { marketId: market.marketId, productId, publicId },
      select: { id: true, publishedAt: true },
    });
    if (row === null || row.publishedAt === null) return null;
    return { publishedAt: fromDate(row.publishedAt), id: row.id as Id<'ProductReview'> };
  }

  // ---- the seller's side (package 4) ---------------------------------------------------------

  async listSellerReviews(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    query: { readonly after: ReviewCursor | null; readonly limit: number },
  ) {
    const rows = await this.prisma.tx(market).reviewsProductReview.findMany({
      where: {
        marketId: market.marketId,
        sellerId,
        status: 'published',
        ...(query.after === null
          ? {}
          : {
              OR: [
                { publishedAt: { lt: toDate(query.after.publishedAt) } },
                { publishedAt: toDate(query.after.publishedAt), id: { lt: query.after.id } },
              ],
            }),
      },
      include: { replies: { where: { sellerId, status: { not: 'superseded' } } } },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
    });
    return rows.map((row) => ({ review: toReview(row), reply: toReply(row.replies[0] ?? null) }));
  }

  async findSellerReview(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    reviewId: Id<'ProductReview'>,
  ) {
    const row = await this.prisma.tx(market).reviewsProductReview.findFirst({
      where: { marketId: market.marketId, sellerId, id: reviewId },
      include: { replies: { where: { sellerId, status: { not: 'superseded' } } } },
    });
    return row === null ? null : { review: toReview(row), reply: toReply(row.replies[0] ?? null) };
  }

  async supersedeReplies(
    market: MarketContext,
    reviewId: Id<'ProductReview'>,
    exceptSellerId: Id<'Seller'> | null,
  ) {
    const changed = await this.prisma.tx(market).reviewsReply.updateMany({
      where: {
        marketId: market.marketId,
        reviewId,
        status: 'published',
        ...(exceptSellerId === null ? {} : { sellerId: { not: exceptSellerId } }),
      },
      data: { status: 'superseded' },
    });
    return changed.count;
  }

  async lockPublishedReviewOf(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    reviewId: Id<'ProductReview'>,
  ) {
    // The row is rewritten with its own value: the write takes the row lock a concurrent move
    // (which also updates the row) must wait for, and the count says whether it is still ours.
    const locked = await this.prisma.tx(market).reviewsProductReview.updateMany({
      where: { marketId: market.marketId, id: reviewId, sellerId, status: 'published' },
      data: { status: 'published' },
    });
    return locked.count > 0;
  }

  async insertReplyIfAbsent(market: MarketContext, reply: ReplyRecord) {
    const created = await this.prisma.tx(market).reviewsReply.createMany({
      data: [
        {
          id: reply.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          reviewId: reply.reviewId,
          sellerId: reply.sellerId,
          body: reply.body,
          status: reply.status,
          createdAt: toDate(reply.createdAt),
        },
      ],
      skipDuplicates: true,
    });
    return created.count > 0;
  }

  async saveReply(market: MarketContext, reply: ReplyRecord) {
    // Only the shop's own published reply changes, and only its text and edit time: a
    // moderator's status is never written from here.
    await this.prisma.tx(market).reviewsReply.updateMany({
      where: {
        marketId: market.marketId,
        id: reply.id,
        sellerId: reply.sellerId,
        status: 'published',
      },
      data: {
        body: reply.body,
        editedAt: reply.editedAt === null ? null : toDate(reply.editedAt),
      },
    });
  }

  async insertReportIfAbsent(market: MarketContext, report: NewReportRecord) {
    const created = await this.prisma.tx(market).reviewsReport.createMany({
      data: [
        {
          id: report.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          reviewId: report.reviewId,
          reporterAccountId: report.reporterAccountId,
          reasonCode: report.reasonCode,
          status: 'open',
          createdAt: toDate(report.createdAt),
        },
      ],
      skipDuplicates: true,
    });
    return created.count > 0;
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
    let written = 0;
    if (products.length > 0) {
      const groups = await this.productGroups(market, products);
      const current = await this.currentSummaries(market, 'product', products);
      for (const productId of products) {
        written += await this.writeSummary(
          market,
          'product',
          productId,
          summariseStarGroups(groups.get(productId) ?? []),
          null,
          now,
          current.get(productId),
        );
      }
    }
    if (sellers.length > 0) {
      const groups = await this.sellerGroups(market, sellers);
      const current = await this.currentSummaries(market, 'seller', sellers);
      for (const sellerId of sellers) {
        const summary = summariseSellerGroups(groups.get(sellerId) ?? []);
        written += await this.writeSummary(
          market,
          'seller',
          sellerId,
          summary,
          summary,
          now,
          current.get(sellerId),
        );
      }
    }
    return written;
  }

  async summarySubjects(market: MarketContext) {
    const tx = this.prisma.tx(market);
    const [stored, productRows, sellerRows] = await Promise.all([
      tx.reviewsRatingSummary.findMany({
        where: { marketId: market.marketId },
        select: { subjectKind: true, subjectId: true },
      }),
      tx.reviewsProductReview.groupBy({
        by: ['productId'],
        where: { marketId: market.marketId, status: 'published' },
      }),
      tx.reviewsSellerRating.groupBy({
        by: ['sellerId'],
        where: { marketId: market.marketId, status: 'published' },
      }),
    ]);
    const products = new Set<string>(productRows.map((row) => row.productId));
    const sellers = new Set<string>(sellerRows.map((row) => row.sellerId));
    for (const row of stored) {
      (row.subjectKind === 'product' ? products : sellers).add(row.subjectId);
    }
    // Sorted, so two overlapping runs lock the rows in the same order and cannot deadlock.
    return {
      products: [...products].sort() as Id<'Product'>[],
      sellers: [...sellers].sort() as Id<'Seller'>[],
    };
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

  /** The stored rows of a batch of subjects, in one query. */
  private async currentSummaries(
    market: MarketContext,
    kind: 'product' | 'seller',
    subjectIds: readonly string[],
  ) {
    const rows = await this.prisma.tx(market).reviewsRatingSummary.findMany({
      where: { marketId: market.marketId, subjectKind: kind, subjectId: { in: [...subjectIds] } },
    });
    return new Map<string, SummaryRow>(rows.map((row) => [row.subjectId, row]));
  }

  /**
   * Insert-or-change of one summary row; a row whose numbers already match is left alone (no
   * write, no `rebuilt_at` bump). Returns 1 when it wrote, else 0.
   */
  private async writeSummary(
    market: MarketContext,
    kind: 'product' | 'seller',
    subjectId: string,
    stars: StarSummary,
    seller: SellerSummary | null,
    now: Temporal.Instant,
    current: SummaryRow | undefined,
  ) {
    const tx = this.prisma.tx(market);
    const columns = summaryColumns(stars, seller, now);
    const numbers: Partial<typeof columns> = { ...columns };
    delete numbers.rebuiltAt;
    const where = { marketId: market.marketId, subjectKind: kind, subjectId };
    if (current !== undefined) {
      const same = (Object.keys(numbers) as (keyof typeof numbers)[]).every(
        (key) => current[key] === numbers[key],
      );
      if (same) return 0;
    }
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
    await tx.reviewsRatingSummary.updateMany({ where, data: columns });
    return 1;
  }

  // ---- account deletion ---------------------------------------------------------------------

  async detachAccount(market: MarketContext, accountId: Id<'Account'>) {
    const tx = this.prisma.tx(market);
    const reviews = await tx.reviewsProductReview.updateMany({
      where: { marketId: market.marketId, accountId },
      data: { accountId: null, lastSellerOrderId: null },
    });
    const ratings = await tx.reviewsSellerRating.updateMany({
      where: { marketId: market.marketId, accountId },
      data: { accountId: null, sellerOrderId: null },
    });
    return { reviews: reviews.count, ratings: ratings.count };
  }
}
