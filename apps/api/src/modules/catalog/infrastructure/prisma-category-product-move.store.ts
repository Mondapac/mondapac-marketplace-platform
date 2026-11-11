import { Prisma } from '../../../generated/prisma/client';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  CategoryProductMoveStore,
  MoveJobRecord,
  MoveJobState,
} from '../application/ports/category-product-move.store';

type JobRow = Prisma.CatalogCategoryProductMoveJobGetPayload<Record<string, never>>;

const at = (date: Date): Temporal.Instant => Temporal.Instant.fromEpochMilliseconds(date.getTime());

function recordOf(row: JobRow): MoveJobRecord {
  return {
    id: row.id as Id<'CategoryMoveJob'>,
    sourceCategoryId: row.sourceCategoryId as Id<'Category'>,
    targetCategoryId: row.targetCategoryId as Id<'Category'>,
    reason: row.reason,
    state: row.state as MoveJobState,
    createdByAccountId: row.createdByAccountId as Id<'Account'>,
    createdAt: at(row.createdAt),
    startedAt: row.startedAt === null ? null : at(row.startedAt),
    finishedAt: row.finishedAt === null ? null : at(row.finishedAt),
    cursorProductId: row.cursorProductId as Id<'Product'> | null,
    total: row.totalCount,
    moved: row.movedCount,
    skipped: row.skippedCount,
    failed: row.failedCount,
    version: row.version,
  };
}

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/**
 * {@link CategoryProductMoveStore} on `catalog.category_product_move_jobs` and `..._items` (C5a
 * migration 20261111100000). Plain Prisma through `PrismaService.tx(market)`, every statement
 * scoped by `marketId`; no raw SQL. Claims and counter moves are conditional updates guarded by
 * the lease holder, so a runner that lost its lease changes nothing.
 */
export class PrismaCategoryProductMoveStore implements CategoryProductMoveStore {
  constructor(private readonly prisma: PrismaService) {}

  async countProducts(market: MarketContext, categoryId: Id<'Category'>): Promise<number> {
    return this.prisma.tx(market).catalogProduct.count({
      where: {
        marketId: market.marketId,
        status: 'published',
        publishedRevision: { categories: { some: { marketId: market.marketId, categoryId } } },
      },
    });
  }

  async insertJob(
    market: MarketContext,
    job: Parameters<CategoryProductMoveStore['insertJob']>[1],
  ): Promise<boolean> {
    try {
      await this.prisma.tx(market).catalogCategoryProductMoveJob.create({
        data: {
          id: job.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          sourceCategoryId: job.sourceCategoryId,
          targetCategoryId: job.targetCategoryId,
          reason: job.reason,
          state: 'queued',
          createdByAccountId: job.createdByAccountId,
          createdAt: toDate(job.now),
          totalCount: job.total,
          movedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          version: 1,
        },
      });
      return true;
    } catch (error) {
      // The partial unique index: another job of this source is open.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return false;
      }
      throw error;
    }
  }

  async find(market: MarketContext, id: Id<'CategoryMoveJob'>): Promise<MoveJobRecord | null> {
    const row = await this.prisma
      .tx(market)
      .catalogCategoryProductMoveJob.findFirst({ where: { marketId: market.marketId, id } });
    return row === null ? null : recordOf(row);
  }

  async listForSource(
    market: MarketContext,
    sourceCategoryId: Id<'Category'>,
    limit: number,
  ): Promise<readonly MoveJobRecord[]> {
    const rows = await this.prisma.tx(market).catalogCategoryProductMoveJob.findMany({
      where: { marketId: market.marketId, sourceCategoryId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map(recordOf);
  }

  async claim(
    market: MarketContext,
    holder: string,
    now: Temporal.Instant,
    leaseUntil: Temporal.Instant,
  ): Promise<MoveJobRecord | null> {
    const tx = this.prisma.tx(market);
    const due = await tx.catalogCategoryProductMoveJob.findFirst({
      where: {
        marketId: market.marketId,
        OR: [{ state: 'queued' }, { state: 'running', leaseExpiresAt: { lte: toDate(now) } }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (due === null) return null;
    // Conditional on the version read: of two runners, one updates a row.
    const taken = await tx.catalogCategoryProductMoveJob.updateMany({
      where: { marketId: market.marketId, id: due.id, version: due.version },
      data: {
        state: 'running',
        startedAt: due.startedAt ?? toDate(now),
        leaseHolder: holder,
        leaseExpiresAt: toDate(leaseUntil),
        version: due.version + 1,
      },
    });
    if (taken.count !== 1) return null;
    const row = await tx.catalogCategoryProductMoveJob.findFirstOrThrow({
      where: { marketId: market.marketId, id: due.id },
    });
    return recordOf(row);
  }

  async renew(
    market: MarketContext,
    id: Id<'CategoryMoveJob'>,
    holder: string,
    leaseUntil: Temporal.Instant,
  ): Promise<boolean> {
    const done = await this.prisma.tx(market).catalogCategoryProductMoveJob.updateMany({
      where: { marketId: market.marketId, id, state: 'running', leaseHolder: holder },
      data: { leaseExpiresAt: toDate(leaseUntil) },
    });
    return done.count === 1;
  }

  async nextProducts(
    market: MarketContext,
    job: MoveJobRecord,
    limit: number,
  ): Promise<readonly Id<'Product'>[]> {
    const rows = await this.prisma.tx(market).catalogProduct.findMany({
      where: {
        marketId: market.marketId,
        status: 'published',
        ...(job.cursorProductId === null ? {} : { id: { gt: job.cursorProductId } }),
        publishedRevision: {
          categories: {
            some: { marketId: market.marketId, categoryId: job.sourceCategoryId },
          },
        },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map((row) => row.id as Id<'Product'>);
  }

  async recordItem(
    market: MarketContext,
    jobId: Id<'CategoryMoveJob'>,
    productId: Id<'Product'>,
    outcome: Parameters<CategoryProductMoveStore['recordItem']>[3],
    now: Temporal.Instant,
  ): Promise<boolean> {
    try {
      await this.prisma.tx(market).catalogCategoryProductMoveItem.create({
        data: {
          marketId: market.marketId,
          tenantId: market.tenantId,
          jobId,
          productId,
          state: outcome.state,
          revisionId: outcome.state === 'moved' ? outcome.revisionId : null,
          createdAt: toDate(now),
        },
      });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return false;
      }
      throw error;
    }
  }

  async unnotified(
    market: MarketContext,
    jobId: Id<'CategoryMoveJob'>,
    limit: number,
  ): Promise<readonly { readonly productId: Id<'Product'> }[]> {
    const rows = await this.prisma.tx(market).catalogCategoryProductMoveItem.findMany({
      where: { marketId: market.marketId, jobId, state: 'moved', sellerNotifiedAt: null },
      select: { productId: true },
      orderBy: { productId: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({ productId: row.productId as Id<'Product'> }));
  }

  async markNotified(
    market: MarketContext,
    jobId: Id<'CategoryMoveJob'>,
    productId: Id<'Product'>,
    now: Temporal.Instant,
  ): Promise<void> {
    await this.prisma.tx(market).catalogCategoryProductMoveItem.updateMany({
      where: { marketId: market.marketId, jobId, productId, sellerNotifiedAt: null },
      data: { sellerNotifiedAt: toDate(now) },
    });
  }

  async advance(
    market: MarketContext,
    id: Id<'CategoryMoveJob'>,
    holder: string,
    step: Parameters<CategoryProductMoveStore['advance']>[3],
  ): Promise<boolean> {
    const tx = this.prisma.tx(market);
    const row = await tx.catalogCategoryProductMoveJob.findFirst({
      where: { marketId: market.marketId, id, state: 'running', leaseHolder: holder },
    });
    if (row === null) return false;
    const done = await tx.catalogCategoryProductMoveJob.updateMany({
      where: { marketId: market.marketId, id, leaseHolder: holder, version: row.version },
      data: {
        cursorProductId: step.cursor,
        movedCount: row.movedCount + step.moved,
        skippedCount: row.skippedCount + step.skipped,
        failedCount: row.failedCount + step.failed,
        version: row.version + 1,
      },
    });
    return done.count === 1;
  }

  async finish(
    market: MarketContext,
    id: Id<'CategoryMoveJob'>,
    holder: string,
    state: 'done' | 'failed',
    now: Temporal.Instant,
  ): Promise<boolean> {
    const tx = this.prisma.tx(market);
    const row = await tx.catalogCategoryProductMoveJob.findFirst({
      where: { marketId: market.marketId, id, state: 'running', leaseHolder: holder },
    });
    if (row === null) return false;
    const done = await tx.catalogCategoryProductMoveJob.updateMany({
      where: { marketId: market.marketId, id, leaseHolder: holder, version: row.version },
      data: {
        state,
        finishedAt: toDate(now),
        leaseHolder: null,
        leaseExpiresAt: null,
        version: row.version + 1,
      },
    });
    return done.count === 1;
  }
}
