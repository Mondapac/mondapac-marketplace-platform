import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  NewSellerImportJob,
  NewSellerImportPhoto,
  SellerGroupOutcome,
  SellerImportRepository,
  SellerRowFilter,
} from '../application/ports/seller-import.repository';
import type { ImportJobState } from '../domain/import-jobs/import-job-core';
import type { ImportFormat } from '../domain/platform-import/import-file';
import type { SellerImportMode, SellerIgnoredColumn } from '../domain/seller-import/columns';
import type { SellerRowIssue, SellerRowSummary } from '../domain/seller-import/row-check';
import type {
  SellerImportJob,
  SellerRowRecord,
  SellerRowRunState,
  SellerStopReason,
} from '../domain/seller-import/seller-import-job';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const instantOrNull = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : toInstant(date);

type JobRow = Prisma.CatalogSellerImportJobGetPayload<Record<string, never>>;
type RowRow = Prisma.CatalogSellerImportRowGetPayload<Record<string, never>>;

function jobOf(row: JobRow): SellerImportJob {
  return {
    id: row.id as Id<'SellerImport'>,
    sellerId: row.sellerId as Id<'Seller'>,
    startedByAccountId: row.startedByAccountId as Id<'Account'>,
    startedBySessionId: row.startedBySessionId as Id<'Session'>,
    mode: row.mode as SellerImportMode,
    state: row.state as ImportJobState,
    format: row.format as ImportFormat,
    fileLabel: row.fileLabel,
    fileKey: row.fileKey,
    fileSha256: Buffer.from(row.fileSha256).toString('hex'),
    fileBytes: row.fileBytes,
    fileDeletedAt: instantOrNull(row.fileDeletedAt),
    totalRows: row.totalRows,
    readyRows: row.readyRows,
    errorRows: row.errorRows,
    warningRows: row.warningRows,
    groupCount: row.groupCount,
    ignoredColumns: row.ignoredColumns as unknown as readonly SellerIgnoredColumn[],
    skipErrors: row.skipErrors,
    toImport: row.toImport,
    createdRows: row.createdRows,
    updatedRows: row.updatedRows,
    unchangedRows: row.unchangedRows,
    failedRows: row.failedRows,
    stopReason: row.stopReason as SellerStopReason | null,
    notBefore: instantOrNull(row.notBefore),
    leaseUntil: instantOrNull(row.leaseUntil),
    version: row.version,
    createdAt: toInstant(row.createdAt),
    checkedAt: toInstant(row.checkedAt),
    startedAt: instantOrNull(row.startedAt),
    finishedAt: instantOrNull(row.finishedAt),
  };
}

function rowOf(row: RowRow): SellerRowRecord {
  return {
    rowNumber: row.rowNumber,
    groupRow: row.groupRow,
    checkState: row.checkState as 'ready' | 'error',
    plan: row.plan as 'create' | 'update' | null,
    issues: row.issues as unknown as readonly SellerRowIssue[],
    summary: row.summary as unknown as SellerRowSummary,
    runState: row.runState as SellerRowRunState,
    runCode: row.runCode,
    productId: row.productId,
    offerId: row.offerId,
    productCode: row.productCode,
  };
}

/** The insert batch size: thousands of rows go in a few statements, never one per row. */
const INSERT_BATCH = 500;

/**
 * {@link SellerImportRepository} on `catalog.seller_import_jobs`, `seller_import_rows` and
 * `seller_import_photos` (data design 3.31). Every statement goes through `PrismaService.tx(market)`
 * with `marketId` at the top level of `where`. A change of state is an `updateMany` guarded by the
 * state it expects, so it answers whether it applied.
 */
export class PrismaSellerImportRepository implements SellerImportRepository {
  constructor(private readonly prisma: PrismaService) {}

  async add(
    market: MarketContext,
    job: NewSellerImportJob,
    rows: readonly SellerRowRecord[],
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    await tx.catalogSellerImportJob.create({
      data: {
        id: job.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        sellerId: job.sellerId,
        startedByAccountId: job.startedByAccountId,
        startedBySessionId: job.startedBySessionId,
        mode: job.mode,
        state: 'checked',
        format: job.format,
        fileLabel: job.fileLabel,
        fileKey: job.fileKey,
        fileSha256: Buffer.from(job.fileSha256, 'hex'),
        fileBytes: job.fileBytes,
        totalRows: job.totalRows,
        readyRows: job.readyRows,
        errorRows: job.errorRows,
        warningRows: job.warningRows,
        groupCount: job.groupCount,
        ignoredColumns: job.ignoredColumns as unknown as Prisma.InputJsonValue,
        createdRows: 0,
        updatedRows: 0,
        unchangedRows: 0,
        failedRows: 0,
        version: 1,
        createdAt: toDate(job.createdAt),
        checkedAt: toDate(job.checkedAt),
      },
      select: { id: true },
    });
    for (let from = 0; from < rows.length; from += INSERT_BATCH) {
      await tx.catalogSellerImportRow.createMany({
        data: rows.slice(from, from + INSERT_BATCH).map((row) => ({
          marketId: market.marketId,
          tenantId: market.tenantId,
          jobId: job.id,
          rowNumber: row.rowNumber,
          groupRow: row.groupRow,
          checkState: row.checkState,
          plan: row.plan,
          issues: row.issues as unknown as Prisma.InputJsonValue,
          summary: row.summary as unknown as Prisma.InputJsonValue,
          runState: row.runState,
        })),
      });
    }
  }

  async find(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    id: Id<'SellerImport'>,
  ): Promise<SellerImportJob | null> {
    const row = await this.prisma
      .tx(market)
      .catalogSellerImportJob.findFirst({ where: { marketId: market.marketId, sellerId, id } });
    return row === null ? null : jobOf(row);
  }

  async hasActive(market: MarketContext, sellerId: Id<'Seller'>): Promise<boolean> {
    const found = await this.prisma.tx(market).catalogSellerImportJob.findFirst({
      where: { marketId: market.marketId, sellerId, state: { in: ['queued', 'running'] } },
      select: { id: true },
    });
    return found !== null;
  }

  async latestOf(market: MarketContext, sellerId: Id<'Seller'>): Promise<SellerImportJob | null> {
    const row = await this.prisma.tx(market).catalogSellerImportJob.findFirst({
      where: { marketId: market.marketId, sellerId, state: { not: 'discarded' } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return row === null ? null : jobOf(row);
  }

  async discardChecked(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    accountId: Id<'Account'>,
    now: Temporal.Instant,
  ): Promise<readonly { readonly id: Id<'SellerImport'>; readonly fileKey: string }[]> {
    const tx = this.prisma.tx(market);
    const open = await tx.catalogSellerImportJob.findMany({
      where: {
        marketId: market.marketId,
        sellerId,
        startedByAccountId: accountId,
        state: 'checked',
      },
      select: { id: true, fileKey: true },
    });
    if (open.length === 0) return [];
    await tx.catalogSellerImportJob.updateMany({
      where: { marketId: market.marketId, id: { in: open.map((job) => job.id) }, state: 'checked' },
      data: { state: 'discarded', finishedAt: toDate(now), version: { increment: 1 } },
    });
    return open.map((job) => ({ id: job.id as Id<'SellerImport'>, fileKey: job.fileKey }));
  }

  async rows(
    market: MarketContext,
    id: Id<'SellerImport'>,
    filter: SellerRowFilter,
    page: { readonly offset: number; readonly limit: number },
  ): Promise<readonly SellerRowRecord[]> {
    const found = await this.prisma.tx(market).catalogSellerImportRow.findMany({
      where: {
        marketId: market.marketId,
        jobId: id,
        ...(filter.checkState === undefined ? {} : { checkState: filter.checkState }),
        ...(filter.runState === undefined ? {} : { runState: filter.runState }),
      },
      orderBy: { rowNumber: 'asc' },
      skip: page.offset,
      take: page.limit,
    });
    return found.map(rowOf);
  }

  async confirm(
    market: MarketContext,
    id: Id<'SellerImport'>,
    choice: {
      readonly skipErrors: boolean;
      readonly toImport: number;
      readonly now: Temporal.Instant;
    },
  ): Promise<boolean> {
    const tx = this.prisma.tx(market);
    const { count } = await tx.catalogSellerImportJob.updateMany({
      where: { marketId: market.marketId, id, state: 'checked' },
      data: {
        state: 'queued',
        skipErrors: choice.skipErrors,
        toImport: choice.toImport,
        startedAt: toDate(choice.now),
        version: { increment: 1 },
      },
    });
    if (count !== 1) return false;
    await tx.catalogSellerImportRow.updateMany({
      where: { marketId: market.marketId, jobId: id, checkState: 'error' },
      data: { runState: 'skipped' },
    });
    return true;
  }

  async resume(market: MarketContext, id: Id<'SellerImport'>): Promise<boolean> {
    const { count } = await this.prisma.tx(market).catalogSellerImportJob.updateMany({
      where: { marketId: market.marketId, id, state: 'stopped' },
      data: {
        state: 'queued',
        stopReason: null,
        notBefore: null,
        leaseUntil: null,
        finishedAt: null,
        version: { increment: 1 },
      },
    });
    return count === 1;
  }

  async discard(
    market: MarketContext,
    id: Id<'SellerImport'>,
    now: Temporal.Instant,
  ): Promise<{ readonly fileKey: string } | null> {
    const tx = this.prisma.tx(market);
    const job = await tx.catalogSellerImportJob.findFirst({
      where: { marketId: market.marketId, id, state: 'checked' },
      select: { fileKey: true },
    });
    if (job === null) return null;
    const { count } = await tx.catalogSellerImportJob.updateMany({
      where: { marketId: market.marketId, id, state: 'checked' },
      data: { state: 'discarded', finishedAt: toDate(now), version: { increment: 1 } },
    });
    return count === 1 ? { fileKey: job.fileKey } : null;
  }

  async claim(
    market: MarketContext,
    now: Temporal.Instant,
    leaseUntil: Temporal.Instant,
  ): Promise<SellerImportJob | null> {
    const tx = this.prisma.tx(market);
    const nowDate = toDate(now);
    const due = await tx.catalogSellerImportJob.findFirst({
      where: {
        marketId: market.marketId,
        OR: [
          { state: 'queued', OR: [{ notBefore: null }, { notBefore: { lte: nowDate } }] },
          { state: 'running', leaseUntil: { lt: nowDate } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (due === null) return null;
    const { count } = await tx.catalogSellerImportJob.updateMany({
      where: { marketId: market.marketId, id: due.id, state: due.state, version: due.version },
      data: {
        state: 'running',
        leaseUntil: toDate(leaseUntil),
        notBefore: null,
        version: { increment: 1 },
      },
    });
    if (count !== 1) return null;
    const claimed = await tx.catalogSellerImportJob.findFirst({
      where: { marketId: market.marketId, id: due.id },
    });
    return claimed === null ? null : jobOf(claimed);
  }

  async renewLease(
    market: MarketContext,
    id: Id<'SellerImport'>,
    leaseUntil: Temporal.Instant,
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).catalogSellerImportJob.updateMany({
      where: { marketId: market.marketId, id, state: 'running' },
      data: { leaseUntil: toDate(leaseUntil) },
    });
    return count === 1;
  }

  async pendingRows(
    market: MarketContext,
    id: Id<'SellerImport'>,
    limit: number,
  ): Promise<readonly SellerRowRecord[]> {
    const rows = this.prisma.tx(market).catalogSellerImportRow;
    const base = {
      marketId: market.marketId,
      jobId: id,
      checkState: 'ready',
      runState: 'pending',
    } as const;
    const first = await rows.findMany({ where: base, orderBy: { rowNumber: 'asc' }, take: limit });
    const last = first.at(-1);
    if (last === undefined) return [];
    // The rest of the last group, so a group is never split across two batches.
    const rest = await rows.findMany({
      where: { ...base, groupRow: last.groupRow, rowNumber: { gt: last.rowNumber } },
      orderBy: { rowNumber: 'asc' },
    });
    return [...first, ...rest].map(rowOf);
  }

  async recordGroup(
    market: MarketContext,
    id: Id<'SellerImport'>,
    groupRow: number,
    record: {
      readonly productId: string | null;
      readonly offerId: string | null;
      readonly productCode: string | null;
    },
  ): Promise<void> {
    await this.prisma.tx(market).catalogSellerImportRow.updateMany({
      where: { marketId: market.marketId, jobId: id, groupRow, runState: 'pending' },
      data: {
        ...(record.productId === null ? {} : { productId: record.productId }),
        ...(record.offerId === null ? {} : { offerId: record.offerId }),
        ...(record.productCode === null ? {} : { productCode: record.productCode }),
      },
    });
  }

  async settleGroup(
    market: MarketContext,
    id: Id<'SellerImport'>,
    groupRow: number,
    outcome: SellerGroupOutcome,
  ): Promise<number> {
    const tx = this.prisma.tx(market);
    const { count } = await tx.catalogSellerImportRow.updateMany({
      where: {
        marketId: market.marketId,
        jobId: id,
        groupRow,
        checkState: 'ready',
        runState: 'pending',
      },
      data:
        outcome.state === 'failed'
          ? { runState: 'failed', runCode: outcome.code }
          : {
              runState: outcome.state,
              ...(outcome.productId === null ? {} : { productId: outcome.productId }),
              ...(outcome.offerId === null ? {} : { offerId: outcome.offerId }),
              ...(outcome.productCode === null ? {} : { productCode: outcome.productCode }),
            },
    });
    // A row settles once: a repeated call changes neither the rows nor the counters.
    if (count === 0) return 0;
    const counter =
      outcome.state === 'created'
        ? { createdRows: { increment: count } }
        : outcome.state === 'updated'
          ? { updatedRows: { increment: count } }
          : outcome.state === 'unchanged'
            ? { unchangedRows: { increment: count } }
            : { failedRows: { increment: count } };
    await tx.catalogSellerImportJob.updateMany({
      where: { marketId: market.marketId, id },
      data: counter,
    });
    return count;
  }

  async failRemaining(
    market: MarketContext,
    id: Id<'SellerImport'>,
    code: string,
  ): Promise<number> {
    const tx = this.prisma.tx(market);
    const { count } = await tx.catalogSellerImportRow.updateMany({
      where: { marketId: market.marketId, jobId: id, checkState: 'ready', runState: 'pending' },
      data: { runState: 'failed', runCode: code },
    });
    if (count > 0) {
      await tx.catalogSellerImportJob.updateMany({
        where: { marketId: market.marketId, id },
        data: { failedRows: { increment: count } },
      });
    }
    return count;
  }

  async endTurn(
    market: MarketContext,
    id: Id<'SellerImport'>,
    next:
      | { readonly state: 'queued'; readonly notBefore: Temporal.Instant | null }
      | { readonly state: 'finished'; readonly now: Temporal.Instant }
      | { readonly state: 'stopped'; readonly reason: SellerStopReason },
  ): Promise<number | null> {
    const tx = this.prisma.tx(market);
    const data: Prisma.CatalogSellerImportJobUpdateManyMutationInput =
      next.state === 'queued'
        ? {
            state: 'queued',
            notBefore: next.notBefore === null ? null : toDate(next.notBefore),
            leaseUntil: null,
            version: { increment: 1 },
          }
        : next.state === 'finished'
          ? {
              state: 'finished',
              finishedAt: toDate(next.now),
              leaseUntil: null,
              notBefore: null,
              version: { increment: 1 },
            }
          : {
              state: 'stopped',
              stopReason: next.reason,
              leaseUntil: null,
              notBefore: null,
              version: { increment: 1 },
            };
    const { count } = await tx.catalogSellerImportJob.updateMany({
      where: { marketId: market.marketId, id, state: 'running' },
      data,
    });
    if (count !== 1) return null;
    const row = await tx.catalogSellerImportJob.findFirst({
      where: { marketId: market.marketId, id },
      select: { version: true },
    });
    return row?.version ?? null;
  }

  async filesDue(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<readonly { readonly id: Id<'SellerImport'>; readonly fileKey: string }[]> {
    const found = await this.prisma.tx(market).catalogSellerImportJob.findMany({
      where: {
        marketId: market.marketId,
        fileDeletedAt: null,
        state: { notIn: ['queued', 'running'] },
        OR: [{ checkedAt: { lt: toDate(before) } }, { state: 'discarded' }],
      },
      orderBy: [{ checkedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, fileKey: true },
    });
    return found.map((job) => ({ id: job.id as Id<'SellerImport'>, fileKey: job.fileKey }));
  }

  async markFileDeleted(
    market: MarketContext,
    id: Id<'SellerImport'>,
    now: Temporal.Instant,
  ): Promise<void> {
    const jobs = this.prisma.tx(market).catalogSellerImportJob;
    // A checked file that was never confirmed and is now gone cannot be imported: it is discarded.
    await jobs.updateMany({
      where: { marketId: market.marketId, id, fileDeletedAt: null, state: 'checked' },
      data: {
        fileDeletedAt: toDate(now),
        state: 'discarded',
        finishedAt: toDate(now),
        version: { increment: 1 },
      },
    });
    await jobs.updateMany({
      where: { marketId: market.marketId, id, fileDeletedAt: null },
      data: { fileDeletedAt: toDate(now) },
    });
  }

  async deleteSettledBefore(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<number> {
    const tx = this.prisma.tx(market);
    const old = await tx.catalogSellerImportJob.findMany({
      where: {
        marketId: market.marketId,
        createdAt: { lt: toDate(before) },
        state: { in: ['finished', 'stopped'] },
        fileDeletedAt: { not: null },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });
    if (old.length === 0) return 0;
    const { count } = await tx.catalogSellerImportJob.deleteMany({
      where: { marketId: market.marketId, id: { in: old.map((job) => job.id) } },
    });
    return count;
  }

  async deleteDiscarded(
    market: MarketContext,
    scope: { readonly ids: readonly Id<'SellerImport'>[] } | { readonly limit: number },
  ): Promise<number> {
    const tx = this.prisma.tx(market);
    const base = {
      marketId: market.marketId,
      state: 'discarded',
      fileDeletedAt: { not: null },
    } as const;
    if ('ids' in scope) {
      if (scope.ids.length === 0) return 0;
      const { count } = await tx.catalogSellerImportJob.deleteMany({
        where: { ...base, id: { in: [...scope.ids] } },
      });
      return count;
    }
    const found = await tx.catalogSellerImportJob.findMany({
      where: base,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: scope.limit,
      select: { id: true },
    });
    if (found.length === 0) return 0;
    const { count } = await tx.catalogSellerImportJob.deleteMany({
      where: { ...base, id: { in: found.map((job) => job.id) } },
    });
    return count;
  }

  async rowsStartedSince(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    since: Temporal.Instant,
  ): Promise<number> {
    const sum = await this.prisma.tx(market).catalogSellerImportJob.aggregate({
      where: {
        marketId: market.marketId,
        sellerId,
        startedAt: { gte: toDate(since) },
      },
      _sum: { toImport: true },
    });
    return sum._sum.toImport ?? 0;
  }

  async photoTargets(
    market: MarketContext,
    id: Id<'SellerImport'>,
  ): Promise<ReadonlyMap<string, string>> {
    const found = await this.prisma.tx(market).catalogSellerImportRow.findMany({
      where: {
        marketId: market.marketId,
        jobId: id,
        productId: { not: null },
        runState: { in: ['created', 'updated', 'unchanged'] },
      },
      orderBy: { rowNumber: 'asc' },
      select: { rowNumber: true, groupRow: true, productId: true, summary: true },
    });
    const targets = new Map<string, string>();
    for (const row of found) {
      // The names are listed on the first row of a group only.
      if (row.rowNumber !== row.groupRow || row.productId === null) continue;
      const images = (row.summary as { images?: unknown }).images;
      if (!Array.isArray(images)) continue;
      for (const name of images as unknown[]) {
        if (typeof name !== 'string') continue;
        const key = name.toLowerCase();
        if (!targets.has(key)) targets.set(key, row.productId);
      }
    }
    return targets;
  }

  async addPhoto(market: MarketContext, photo: NewSellerImportPhoto): Promise<boolean> {
    const { count } = await this.prisma.tx(market).catalogSellerImportPhoto.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          jobId: photo.jobId,
          nameKey: photo.nameKey,
          productId: photo.productId,
          imageId: photo.imageId,
          addedAt: toDate(photo.addedAt),
        },
      ],
      skipDuplicates: true,
    });
    return count === 1;
  }

  async photoNames(market: MarketContext, id: Id<'SellerImport'>): Promise<ReadonlySet<string>> {
    const found = await this.prisma.tx(market).catalogSellerImportPhoto.findMany({
      where: { marketId: market.marketId, jobId: id },
      select: { nameKey: true },
    });
    return new Set(found.map((photo) => photo.nameKey));
  }
}
