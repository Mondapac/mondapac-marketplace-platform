import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  NewImportJob,
  PlatformImportRepository,
  RowFilter,
} from '../application/ports/platform-import.repository';
import type { IgnoredColumn } from '../domain/platform-import/columns';
import type { ImportFormat } from '../domain/platform-import/import-file';
import type {
  ImportJob,
  ImportJobState,
  ImportRowRecord,
  RowRunState,
  StartAs,
  StopReason,
} from '../domain/platform-import/platform-import-job';
import type { RowIssue, RowSummary } from '../domain/platform-import/row-check';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const instantOrNull = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : toInstant(date);

type JobRow = Prisma.CatalogPlatformImportJobGetPayload<Record<string, never>>;
type RowRow = Prisma.CatalogPlatformImportRowGetPayload<Record<string, never>>;

function jobOf(row: JobRow): ImportJob {
  return {
    id: row.id as Id<'PlatformImport'>,
    startedByAccountId: row.startedByAccountId as Id<'Account'>,
    startedBySessionId: row.startedBySessionId as Id<'Session'>,
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
    ignoredColumns: row.ignoredColumns as unknown as readonly IgnoredColumn[],
    startAs: row.startAs as StartAs | null,
    skipErrors: row.skipErrors,
    toImport: row.toImport,
    addedRows: row.addedRows,
    failedRows: row.failedRows,
    stopReason: row.stopReason as StopReason | null,
    notBefore: instantOrNull(row.notBefore),
    leaseUntil: instantOrNull(row.leaseUntil),
    version: row.version,
    createdAt: toInstant(row.createdAt),
    checkedAt: toInstant(row.checkedAt),
    startedAt: instantOrNull(row.startedAt),
    finishedAt: instantOrNull(row.finishedAt),
  };
}

function rowOf(row: RowRow): ImportRowRecord {
  return {
    rowNumber: row.rowNumber,
    checkState: row.checkState as 'ready' | 'error',
    issues: row.issues as unknown as readonly RowIssue[],
    summary: row.summary as unknown as RowSummary,
    runState: row.runState as RowRunState,
    runCode: row.runCode,
    productId: row.productId,
    productCode: row.productCode,
  };
}

/** The insert batch size: 5,000 rows go in a few statements, never one per row. */
const INSERT_BATCH = 500;

/**
 * {@link PlatformImportRepository} on `catalog.platform_import_jobs` and `platform_import_rows`
 * (data design 3.29). Every statement goes through `PrismaService.tx(market)` with `marketId` at the
 * top level of `where`. A change of state is an `updateMany` guarded by the state it expects, so
 * it answers whether it applied.
 */
export class PrismaPlatformImportRepository implements PlatformImportRepository {
  constructor(private readonly prisma: PrismaService) {}

  async add(
    market: MarketContext,
    job: NewImportJob,
    rows: readonly ImportRowRecord[],
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    await tx.catalogPlatformImportJob.create({
      data: {
        id: job.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        startedByAccountId: job.startedByAccountId,
        startedBySessionId: job.startedBySessionId,
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
        ignoredColumns: job.ignoredColumns as unknown as Prisma.InputJsonValue,
        addedRows: 0,
        failedRows: 0,
        version: 1,
        createdAt: toDate(job.createdAt),
        checkedAt: toDate(job.checkedAt),
      },
      select: { id: true },
    });
    for (let from = 0; from < rows.length; from += INSERT_BATCH) {
      await tx.catalogPlatformImportRow.createMany({
        data: rows.slice(from, from + INSERT_BATCH).map((row) => ({
          marketId: market.marketId,
          tenantId: market.tenantId,
          jobId: job.id,
          rowNumber: row.rowNumber,
          checkState: row.checkState,
          issues: row.issues as unknown as Prisma.InputJsonValue,
          summary: row.summary as unknown as Prisma.InputJsonValue,
          runState: row.runState,
        })),
      });
    }
  }

  async find(market: MarketContext, id: Id<'PlatformImport'>): Promise<ImportJob | null> {
    const row = await this.prisma
      .tx(market)
      .catalogPlatformImportJob.findFirst({ where: { marketId: market.marketId, id } });
    return row === null ? null : jobOf(row);
  }

  async hasActive(market: MarketContext, accountId: Id<'Account'>): Promise<boolean> {
    const found = await this.prisma.tx(market).catalogPlatformImportJob.findFirst({
      where: {
        marketId: market.marketId,
        startedByAccountId: accountId,
        state: { in: ['queued', 'running'] },
      },
      select: { id: true },
    });
    return found !== null;
  }

  async latestOf(market: MarketContext, accountId: Id<'Account'>): Promise<ImportJob | null> {
    const row = await this.prisma.tx(market).catalogPlatformImportJob.findFirst({
      where: {
        marketId: market.marketId,
        startedByAccountId: accountId,
        state: { not: 'discarded' },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return row === null ? null : jobOf(row);
  }

  async discardChecked(
    market: MarketContext,
    accountId: Id<'Account'>,
    now: Temporal.Instant,
  ): Promise<readonly { readonly id: Id<'PlatformImport'>; readonly fileKey: string }[]> {
    const tx = this.prisma.tx(market);
    const open = await tx.catalogPlatformImportJob.findMany({
      where: { marketId: market.marketId, startedByAccountId: accountId, state: 'checked' },
      select: { id: true, fileKey: true },
    });
    if (open.length === 0) return [];
    await tx.catalogPlatformImportJob.updateMany({
      where: { marketId: market.marketId, id: { in: open.map((job) => job.id) }, state: 'checked' },
      data: { state: 'discarded', finishedAt: toDate(now), version: { increment: 1 } },
    });
    return open.map((job) => ({ id: job.id as Id<'PlatformImport'>, fileKey: job.fileKey }));
  }

  async rows(
    market: MarketContext,
    id: Id<'PlatformImport'>,
    filter: RowFilter,
    page: { readonly offset: number; readonly limit: number },
  ): Promise<readonly ImportRowRecord[]> {
    const found = await this.prisma.tx(market).catalogPlatformImportRow.findMany({
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
    id: Id<'PlatformImport'>,
    choice: {
      readonly startAs: StartAs;
      readonly skipErrors: boolean;
      readonly toImport: number;
      readonly now: Temporal.Instant;
    },
  ): Promise<boolean> {
    const tx = this.prisma.tx(market);
    const { count } = await tx.catalogPlatformImportJob.updateMany({
      where: { marketId: market.marketId, id, state: 'checked' },
      data: {
        state: 'queued',
        startAs: choice.startAs,
        skipErrors: choice.skipErrors,
        toImport: choice.toImport,
        startedAt: toDate(choice.now),
        version: { increment: 1 },
      },
    });
    if (count !== 1) return false;
    await tx.catalogPlatformImportRow.updateMany({
      where: { marketId: market.marketId, jobId: id, checkState: 'error' },
      data: { runState: 'skipped' },
    });
    return true;
  }

  async resume(market: MarketContext, id: Id<'PlatformImport'>): Promise<boolean> {
    const { count } = await this.prisma.tx(market).catalogPlatformImportJob.updateMany({
      where: { marketId: market.marketId, id, state: 'stopped' },
      data: {
        state: 'queued',
        stopReason: null,
        notBefore: null,
        leaseUntil: null,
        version: { increment: 1 },
      },
    });
    return count === 1;
  }

  async discard(
    market: MarketContext,
    id: Id<'PlatformImport'>,
    now: Temporal.Instant,
  ): Promise<{ readonly fileKey: string } | null> {
    const tx = this.prisma.tx(market);
    const job = await tx.catalogPlatformImportJob.findFirst({
      where: { marketId: market.marketId, id, state: 'checked' },
      select: { fileKey: true },
    });
    if (job === null) return null;
    const { count } = await tx.catalogPlatformImportJob.updateMany({
      where: { marketId: market.marketId, id, state: 'checked' },
      data: { state: 'discarded', finishedAt: toDate(now), version: { increment: 1 } },
    });
    return count === 1 ? { fileKey: job.fileKey } : null;
  }

  async claim(
    market: MarketContext,
    now: Temporal.Instant,
    leaseUntil: Temporal.Instant,
  ): Promise<ImportJob | null> {
    const tx = this.prisma.tx(market);
    const nowDate = toDate(now);
    const due = await tx.catalogPlatformImportJob.findFirst({
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
    const { count } = await tx.catalogPlatformImportJob.updateMany({
      where: {
        marketId: market.marketId,
        id: due.id,
        state: due.state,
        version: due.version,
      },
      data: {
        state: 'running',
        leaseUntil: toDate(leaseUntil),
        notBefore: null,
        version: { increment: 1 },
      },
    });
    if (count !== 1) return null;
    const claimed = await tx.catalogPlatformImportJob.findFirst({
      where: { marketId: market.marketId, id: due.id },
    });
    return claimed === null ? null : jobOf(claimed);
  }

  async renewLease(
    market: MarketContext,
    id: Id<'PlatformImport'>,
    leaseUntil: Temporal.Instant,
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).catalogPlatformImportJob.updateMany({
      where: { marketId: market.marketId, id, state: 'running' },
      data: { leaseUntil: toDate(leaseUntil) },
    });
    return count === 1;
  }

  async pendingRows(
    market: MarketContext,
    id: Id<'PlatformImport'>,
    limit: number,
  ): Promise<readonly ImportRowRecord[]> {
    return this.rows(
      market,
      id,
      { checkState: 'ready', runState: 'pending' },
      { offset: 0, limit },
    );
  }

  async recordProduct(
    market: MarketContext,
    id: Id<'PlatformImport'>,
    rowNumber: number,
    product: { readonly productId: string; readonly productCode: string },
  ): Promise<void> {
    await this.prisma.tx(market).catalogPlatformImportRow.updateMany({
      where: { marketId: market.marketId, jobId: id, rowNumber, runState: 'pending' },
      data: { productId: product.productId, productCode: product.productCode },
    });
  }

  async settleRow(
    market: MarketContext,
    id: Id<'PlatformImport'>,
    rowNumber: number,
    outcome:
      | { readonly state: 'added'; readonly productId: string; readonly productCode: string }
      | { readonly state: 'failed'; readonly code: string },
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    const { count } = await tx.catalogPlatformImportRow.updateMany({
      where: { marketId: market.marketId, jobId: id, rowNumber, runState: 'pending' },
      data:
        outcome.state === 'added'
          ? {
              runState: 'added',
              productId: outcome.productId,
              productCode: outcome.productCode,
            }
          : { runState: 'failed', runCode: outcome.code },
    });
    // A row settles once: a repeated call changes neither the row nor the counter.
    if (count !== 1) return;
    await tx.catalogPlatformImportJob.updateMany({
      where: { marketId: market.marketId, id },
      data:
        outcome.state === 'added'
          ? { addedRows: { increment: 1 } }
          : { failedRows: { increment: 1 } },
    });
  }

  async endTurn(
    market: MarketContext,
    id: Id<'PlatformImport'>,
    next:
      | { readonly state: 'queued'; readonly notBefore: Temporal.Instant | null }
      | { readonly state: 'finished'; readonly now: Temporal.Instant }
      | { readonly state: 'stopped'; readonly reason: StopReason },
  ): Promise<number | null> {
    const tx = this.prisma.tx(market);
    const data: Prisma.CatalogPlatformImportJobUpdateManyMutationInput =
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
    const { count } = await tx.catalogPlatformImportJob.updateMany({
      where: { marketId: market.marketId, id, state: 'running' },
      data,
    });
    if (count !== 1) return null;
    const row = await tx.catalogPlatformImportJob.findFirst({
      where: { marketId: market.marketId, id },
      select: { version: true },
    });
    return row?.version ?? null;
  }

  async filesDue(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<readonly { readonly id: Id<'PlatformImport'>; readonly fileKey: string }[]> {
    const found = await this.prisma.tx(market).catalogPlatformImportJob.findMany({
      where: {
        marketId: market.marketId,
        fileDeletedAt: null,
        // A job still queued or running needs its file.
        state: { notIn: ['queued', 'running'] },
        // A discarded job will never be read again: its file is due at once.
        OR: [{ checkedAt: { lt: toDate(before) } }, { state: 'discarded' }],
      },
      orderBy: [{ checkedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, fileKey: true },
    });
    return found.map((job) => ({ id: job.id as Id<'PlatformImport'>, fileKey: job.fileKey }));
  }

  async markFileDeleted(
    market: MarketContext,
    id: Id<'PlatformImport'>,
    now: Temporal.Instant,
  ): Promise<void> {
    const jobs = this.prisma.tx(market).catalogPlatformImportJob;
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
    const old = await tx.catalogPlatformImportJob.findMany({
      where: {
        marketId: market.marketId,
        createdAt: { lt: toDate(before) },
        state: { in: ['finished', 'stopped'] },
        // The file goes first (the purge job); a job is deleted only without its file.
        fileDeletedAt: { not: null },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });
    if (old.length === 0) return 0;
    const { count } = await tx.catalogPlatformImportJob.deleteMany({
      where: { marketId: market.marketId, id: { in: old.map((job) => job.id) } },
    });
    return count;
  }

  async deleteDiscarded(
    market: MarketContext,
    scope: { readonly ids: readonly Id<'PlatformImport'>[] } | { readonly limit: number },
  ): Promise<number> {
    const tx = this.prisma.tx(market);
    const base = {
      marketId: market.marketId,
      state: 'discarded',
      // The file goes first; a job is deleted only without its file.
      fileDeletedAt: { not: null },
    } as const;
    if ('ids' in scope) {
      if (scope.ids.length === 0) return 0;
      const { count } = await tx.catalogPlatformImportJob.deleteMany({
        where: { ...base, id: { in: [...scope.ids] } },
      });
      return count;
    }
    const found = await tx.catalogPlatformImportJob.findMany({
      where: base,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: scope.limit,
      select: { id: true },
    });
    if (found.length === 0) return 0;
    const { count } = await tx.catalogPlatformImportJob.deleteMany({
      where: { ...base, id: { in: found.map((job) => job.id) } },
    });
    return count;
  }
}
