import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  CategoryOfferReviewChangeEntry,
  CategoryOfferReviewFlagsStore,
  FlaggedCategoryView,
} from '../application/ports/category-offer-review-flags.store';
import { CategoryOfferReviewFlags } from '../domain/category-offer-review-flags';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** The columns `find` reads, named (Mojtaba L2 on PR #1358): never a `SELECT *`. */
const COLUMNS = {
  marketId: true,
  categoryId: true,
  alwaysReview: true,
  alwaysReviewChangedAt: true,
  alwaysReviewChangedByAccountId: true,
  reviewStop: true,
  reviewStopChangedAt: true,
  reviewStopChangedByAccountId: true,
  version: true,
  createdAt: true,
} as const;

/**
 * {@link CategoryOfferReviewFlagsStore} over Prisma, in the caller's unit, every statement scoped
 * by `market_id`. The flags row is created by the first change at version 1; every later change
 * is one UPDATE on the version seen, raising it by one (the guard trigger allows nothing else).
 * The facts read takes the few flagged rows of the Market once and leaves the ancestor walk to
 * the category paths reader; no join across tables.
 */
export class PrismaCategoryOfferReviewFlagsStore implements CategoryOfferReviewFlagsStore {
  constructor(private readonly prisma: PrismaService) {}

  async categoryExists(market: MarketContext, categoryId: Id<'Category'>): Promise<boolean> {
    const row = await this.prisma.tx(market).catalogPlatformCategory.findFirst({
      where: { marketId: market.marketId, id: categoryId },
      select: { id: true },
    });
    return row !== null;
  }

  async find(market: MarketContext, categoryId: Id<'Category'>): Promise<CategoryOfferReviewFlags> {
    const row = await this.prisma.tx(market).catalogCategoryOfferReviewFlags.findFirst({
      where: { marketId: market.marketId, categoryId },
      select: COLUMNS,
    });
    if (row === null) return CategoryOfferReviewFlags.none(market.marketId, categoryId);
    return CategoryOfferReviewFlags.restore({
      marketId: row.marketId as MarketId,
      categoryId: row.categoryId as Id<'Category'>,
      alwaysReview: {
        on: row.alwaysReview,
        changedAt: toInstant(row.alwaysReviewChangedAt),
        changedBy: row.alwaysReviewChangedByAccountId as Id<'Account'> | null,
      },
      reviewStop: {
        on: row.reviewStop,
        changedAt: toInstant(row.reviewStopChangedAt),
        changedBy: row.reviewStopChangedByAccountId as Id<'Account'> | null,
      },
      version: row.version,
      createdAt: toInstant(row.createdAt),
    });
  }

  async save(
    market: MarketContext,
    flags: CategoryOfferReviewFlags,
    expectedVersion: number,
  ): Promise<boolean> {
    const state = flags.state;
    if (state.marketId !== market.marketId) throw new Error('save: another Market');
    const table = this.prisma.tx(market).catalogCategoryOfferReviewFlags;
    const columns = {
      alwaysReview: state.alwaysReview.on,
      alwaysReviewChangedAt:
        state.alwaysReview.changedAt === null ? null : toDate(state.alwaysReview.changedAt),
      alwaysReviewChangedByAccountId: state.alwaysReview.changedBy,
      reviewStop: state.reviewStop.on,
      reviewStopChangedAt:
        state.reviewStop.changedAt === null ? null : toDate(state.reviewStop.changedAt),
      reviewStopChangedByAccountId: state.reviewStop.changedBy,
    };
    if (expectedVersion === 0) {
      if (state.createdAt === null) throw new Error('save: a new row needs its creation time');
      // `ON CONFLICT DO NOTHING`: a row created meanwhile by another change is a lost race.
      const { count } = await table.createMany({
        data: [
          {
            marketId: market.marketId,
            tenantId: market.tenantId,
            categoryId: state.categoryId,
            ...columns,
            version: 1,
            createdAt: toDate(state.createdAt),
          },
        ],
        skipDuplicates: true,
      });
      return count === 1;
    }
    const { count } = await table.updateMany({
      where: { marketId: market.marketId, categoryId: state.categoryId, version: expectedVersion },
      data: { ...columns, version: expectedVersion + 1 },
    });
    return count === 1;
  }

  async appendChange(market: MarketContext, entry: CategoryOfferReviewChangeEntry): Promise<void> {
    await this.prisma.tx(market).catalogCategoryOfferReviewChange.create({
      data: {
        id: entry.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        categoryId: entry.categoryId,
        flag: entry.flag,
        previousValue: entry.previous,
        newValue: entry.next,
        reason: entry.reason,
        changedByAccountId: entry.by,
        changedAt: toDate(entry.at),
      },
      select: { id: true },
    });
  }

  async listFlagged(market: MarketContext): Promise<readonly FlaggedCategoryView[]> {
    const rows = await this.prisma.tx(market).catalogCategoryOfferReviewFlags.findMany({
      where: { marketId: market.marketId, OR: [{ alwaysReview: true }, { reviewStop: true }] },
      select: {
        categoryId: true,
        alwaysReview: true,
        alwaysReviewChangedAt: true,
        reviewStop: true,
        reviewStopChangedAt: true,
        version: true,
      },
      orderBy: { categoryId: 'asc' },
    });
    return rows.map((row) => ({
      categoryId: row.categoryId,
      alwaysReview: row.alwaysReview,
      reviewStop: row.reviewStop,
      version: row.version,
      alwaysReviewChangedAt: toInstant(row.alwaysReviewChangedAt),
      reviewStopChangedAt: toInstant(row.reviewStopChangedAt),
    }));
  }

  async publishedCategoryIds(
    market: MarketContext,
    productId: Id<'Product'>,
  ): Promise<readonly string[]> {
    const tx = this.prisma.tx(market);
    const product = await tx.catalogProduct.findFirst({
      where: { marketId: market.marketId, id: productId },
      select: { publishedRevisionId: true },
    });
    if (product?.publishedRevisionId == null) return [];
    const rows = await tx.catalogProductRevisionCategory.findMany({
      where: { marketId: market.marketId, revisionId: product.publishedRevisionId },
      select: { categoryId: true },
    });
    return [...new Set(rows.map((row) => row.categoryId))];
  }
}
