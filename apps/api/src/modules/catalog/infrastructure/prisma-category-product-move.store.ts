import { Prisma } from '../../../generated/prisma/client';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  CategoryProductMoveStore,
  MoveJobRecord,
  MoveJobState,
  MoveScanOutcome,
} from '../application/ports/category-product-move.store';
import type { ProductCategoryNode } from '../domain/product-category-rules';

/** At most this many categories up a chain (the tree is at most a few levels deep). */
const CHAIN_MAX = 16;

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
    scanOutcome: row.scanOutcome as MoveScanOutcome | null,
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
    // ON CONFLICT DO NOTHING (N6): a duplicate is a count of 0, never a failed statement, so the
    // caller's interactive transaction is not aborted (25P02) and its later statements still run.
    const written = await this.prisma.tx(market).catalogCategoryProductMoveItem.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          jobId,
          productId,
          state: outcome.state,
          revisionId: null,
          createdAt: toDate(now),
        },
      ],
      skipDuplicates: true,
    });
    return written.count === 1;
  }

  async markMoved(
    market: MarketContext,
    jobId: Id<'CategoryMoveJob'>,
    productId: Id<'Product'>,
    revisionId: Id<'ProductRevision'>,
  ): Promise<boolean> {
    const done = await this.prisma.tx(market).catalogCategoryProductMoveItem.updateMany({
      where: { marketId: market.marketId, jobId, productId, state: 'pending' },
      data: { state: 'moved', revisionId },
    });
    return done.count === 1;
  }

  async categoryChain(
    market: MarketContext,
    categoryId: Id<'Category'>,
  ): Promise<readonly ProductCategoryNode[]> {
    const tx = this.prisma.tx(market);
    const chain: ProductCategoryNode[] = [];
    const seen = new Set<string>();
    let cursor: string | null = categoryId;
    // The tree is a few levels deep; the bound only stops a broken (looping) chain.
    while (cursor !== null && !seen.has(cursor) && chain.length < CHAIN_MAX) {
      seen.add(cursor);
      const row: { id: string; parentId: string | null; status: string } | null =
        await tx.catalogPlatformCategory.findFirst({
          where: { marketId: market.marketId, id: cursor },
          select: { id: true, parentId: true, status: true },
        });
      if (row === null) break;
      chain.push(row);
      cursor = row.parentId;
    }
    return chain;
  }

  async unnotified(
    market: MarketContext,
    jobId: Id<'CategoryMoveJob'>,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly { readonly productId: Id<'Product'>; readonly attempts: number }[]> {
    const rows = await this.prisma.tx(market).catalogCategoryProductMoveItem.findMany({
      where: {
        ...this.#openNotice(market, jobId),
        OR: [{ noticeNextAttemptAt: null }, { noticeNextAttemptAt: { lte: toDate(now) } }],
      },
      select: { productId: true, noticeAttempts: true },
      orderBy: { productId: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({
      productId: row.productId as Id<'Product'>,
      attempts: row.noticeAttempts,
    }));
  }

  async hasOpenNotices(market: MarketContext, jobId: Id<'CategoryMoveJob'>): Promise<boolean> {
    const row = await this.prisma.tx(market).catalogCategoryProductMoveItem.findFirst({
      where: this.#openNotice(market, jobId),
      select: { productId: true },
    });
    return row !== null;
  }

  /** A moved item whose seller email is neither sent nor given up (the partial index). */
  #openNotice(market: MarketContext, jobId: Id<'CategoryMoveJob'>) {
    return {
      marketId: market.marketId,
      jobId,
      state: 'moved',
      sellerNotifiedAt: null,
      noticeFailedAt: null,
    } satisfies Prisma.CatalogCategoryProductMoveItemWhereInput;
  }

  async markNotified(
    market: MarketContext,
    jobId: Id<'CategoryMoveJob'>,
    productId: Id<'Product'>,
    now: Temporal.Instant,
  ): Promise<void> {
    await this.prisma.tx(market).catalogCategoryProductMoveItem.updateMany({
      where: { ...this.#openNotice(market, jobId), productId },
      data: { sellerNotifiedAt: toDate(now), noticeNextAttemptAt: null },
    });
  }

  async noticeFailed(
    market: MarketContext,
    jobId: Id<'CategoryMoveJob'>,
    productId: Id<'Product'>,
    outcome: { readonly attempts: number; readonly nextAttemptAt: Temporal.Instant | null },
    now: Temporal.Instant,
  ): Promise<void> {
    await this.prisma.tx(market).catalogCategoryProductMoveItem.updateMany({
      where: { ...this.#openNotice(market, jobId), productId },
      data: {
        noticeAttempts: outcome.attempts,
        noticeNextAttemptAt: outcome.nextAttemptAt === null ? null : toDate(outcome.nextAttemptAt),
        noticeFailedAt: outcome.nextAttemptAt === null ? toDate(now) : null,
      },
    });
  }

  async advance(
    market: MarketContext,
    id: Id<'CategoryMoveJob'>,
    holder: string,
    cursor: Id<'Product'>,
  ): Promise<boolean> {
    const tx = this.prisma.tx(market);
    const row = await tx.catalogCategoryProductMoveJob.findFirst({
      where: { marketId: market.marketId, id, state: 'running', leaseHolder: holder },
      select: { version: true },
    });
    if (row === null) return false;
    const done = await tx.catalogCategoryProductMoveJob.updateMany({
      where: { marketId: market.marketId, id, leaseHolder: holder, version: row.version },
      data: {
        cursorProductId: cursor,
        ...(await this.#counts(market, id)),
        version: row.version + 1,
      },
    });
    return done.count === 1;
  }

  /** The job's counters from its items, by state (L2): the items are the truth. */
  async #counts(
    market: MarketContext,
    jobId: Id<'CategoryMoveJob'>,
  ): Promise<{ movedCount: number; skippedCount: number; failedCount: number }> {
    const groups = await this.prisma.tx(market).catalogCategoryProductMoveItem.groupBy({
      by: ['state'],
      where: { marketId: market.marketId, jobId },
      _count: { _all: true },
    });
    const of = (state: string): number =>
      groups.find((group) => group.state === state)?._count._all ?? 0;
    // A committed `pending` item (a unit that ended without its revision) is a failed product:
    // counted, never dropped (N2).
    return {
      movedCount: of('moved'),
      skippedCount: of('skipped'),
      failedCount: of('failed') + of('pending'),
    };
  }

  async endScan(
    market: MarketContext,
    id: Id<'CategoryMoveJob'>,
    holder: string,
    outcome: MoveScanOutcome,
  ): Promise<boolean> {
    const tx = this.prisma.tx(market);
    const row = await tx.catalogCategoryProductMoveJob.findFirst({
      where: {
        marketId: market.marketId,
        id,
        state: 'running',
        leaseHolder: holder,
        scanOutcome: null,
      },
      select: { version: true },
    });
    if (row === null) return false;
    const done = await tx.catalogCategoryProductMoveJob.updateMany({
      where: {
        marketId: market.marketId,
        id,
        leaseHolder: holder,
        scanOutcome: null,
        version: row.version,
      },
      data: { scanOutcome: outcome, ...(await this.#counts(market, id)), version: row.version + 1 },
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
      select: { version: true },
    });
    if (row === null) return false;
    const done = await tx.catalogCategoryProductMoveJob.updateMany({
      where: { marketId: market.marketId, id, leaseHolder: holder, version: row.version },
      data: {
        state,
        ...(await this.#counts(market, id)),
        finishedAt: toDate(now),
        leaseHolder: null,
        leaseExpiresAt: null,
        version: row.version + 1,
      },
    });
    if (done.count !== 1) return false;
    // N2: a pending item (counted as failed above) does not stay pending on an ended job.
    await tx.catalogCategoryProductMoveItem.updateMany({
      where: { marketId: market.marketId, jobId: id, state: 'pending' },
      data: { state: 'failed' },
    });
    return true;
  }
}
