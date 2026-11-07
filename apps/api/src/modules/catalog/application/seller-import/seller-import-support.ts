import { ok, parseId } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SellerIgnoredColumn, SellerImportMode } from '../../domain/seller-import/columns';
import type { SellerCheckEnvironment } from '../../domain/seller-import/row-check';
import {
  PHOTO_WINDOW_DAYS,
  type SellerImportJob,
  type SellerRowRecord,
} from '../../domain/seller-import/seller-import-job';
import {
  readCheckEnvironment,
  type CheckEnvironmentDependencies,
  type CheckEnvironmentFailure,
} from '../platform-import/check-environment';
import type { ImportFileStore } from '../ports/import-file-store';
import type { SellerImportRepository } from '../ports/seller-import.repository';

// What the seller import use cases share (catalog design 14c).

export type SellerImportCommonFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'access.acting-as-refused' }
  | { readonly code: 'import.not-found' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export const sellerImportIdOf = (value: unknown): Id<'SellerImport'> | null => {
  if (typeof value !== 'string') return null;
  const parsed = parseId<'SellerImport'>(value);
  return parsed.ok ? parsed.value : null;
};

/** How many lines of errors and of failures a page of the view carries; the report has them all. */
export const VIEW_ERROR_LINES = 100;
export const VIEW_FAILURE_LINES = 100;
export const VIEW_PREVIEW_ROWS = 5;

export interface SellerErrorLine {
  readonly rowNumber: number;
  readonly column: string;
  readonly code: string;
  readonly value: string;
  readonly otherRow: number | null;
}

export interface SellerFailureLine {
  readonly rowNumber: number;
  readonly sku: string;
  readonly code: string;
}

export interface SellerPreviewRow {
  readonly rowNumber: number;
  readonly sku: string;
  readonly title: string;
  readonly productCode: string;
  readonly typeCode: string;
  readonly options: string;
}

/** What the page shows of a job: counts, state and the lines each step needs. */
export interface SellerImportView {
  readonly id: string;
  readonly mode: SellerImportMode;
  readonly state: SellerImportJob['state'];
  readonly fileLabel: string;
  readonly fileBytes: number;
  readonly format: SellerImportJob['format'];
  readonly rows: number;
  readonly ready: number;
  readonly errors: number;
  readonly warnings: number;
  readonly groups: number;
  readonly ignoredColumns: readonly SellerIgnoredColumn[];
  readonly skipErrors: boolean | null;
  readonly toImport: number | null;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly failed: number;
  readonly stopReason: SellerImportJob['stopReason'];
  readonly canResume: boolean;
  /** The photo step is open for a my-products import that ended, for {@link PHOTO_WINDOW_DAYS} days. */
  readonly photoStepOpen: boolean;
  readonly checkedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationSeconds: number | null;
  readonly errorLines: readonly SellerErrorLine[];
  readonly failureLines: readonly SellerFailureLine[];
  readonly preview: readonly SellerPreviewRow[];
}

export const EMPTY_SELLER_PARTS = { errorRows: [], failedRows: [], previewRows: [] } as const;

export function photoWindowOpen(
  job: Pick<SellerImportJob, 'mode' | 'state' | 'finishedAt' | 'fileDeletedAt'>,
  now: Temporal.Instant,
): boolean {
  if (job.mode !== 'my-products') return false;
  if (job.state !== 'finished' && job.state !== 'stopped') return false;
  if (job.finishedAt === null) return job.state === 'stopped';
  return now.epochMilliseconds - job.finishedAt.epochMilliseconds <= PHOTO_WINDOW_DAYS * 86_400_000;
}

export function errorLinesOf(rows: readonly SellerRowRecord[]): SellerErrorLine[] {
  const lines: SellerErrorLine[] = [];
  for (const row of rows) {
    if (row.checkState !== 'error') continue;
    for (const issue of row.issues) {
      if (issue.severity !== 'error') continue;
      lines.push({
        rowNumber: row.rowNumber,
        column: issue.column,
        code: issue.code,
        value: issue.value,
        otherRow: issue.otherRow ?? null,
      });
    }
  }
  return lines;
}

/** The view of a job; the parts are what the caller read (a bounded page of each). */
export function sellerViewOf(
  job: SellerImportJob,
  parts: {
    readonly errorRows: readonly SellerRowRecord[];
    readonly failedRows: readonly SellerRowRecord[];
    readonly previewRows: readonly SellerRowRecord[];
  },
  now: Temporal.Instant,
): SellerImportView {
  const started = job.startedAt;
  const finished = job.finishedAt;
  return {
    id: job.id,
    mode: job.mode,
    state: job.state,
    fileLabel: job.fileLabel,
    fileBytes: job.fileBytes,
    format: job.format,
    rows: job.totalRows,
    ready: job.readyRows,
    errors: job.errorRows,
    warnings: job.warningRows,
    groups: job.groupCount,
    ignoredColumns: job.ignoredColumns,
    skipErrors: job.skipErrors,
    toImport: job.toImport,
    created: job.createdRows,
    updated: job.updatedRows,
    unchanged: job.unchangedRows,
    failed: job.failedRows,
    stopReason: job.stopReason,
    canResume: job.state === 'stopped' && job.fileDeletedAt === null,
    photoStepOpen: photoWindowOpen(job, now),
    checkedAt: job.checkedAt.toString(),
    startedAt: started === null ? null : started.toString(),
    finishedAt: finished === null ? null : finished.toString(),
    durationSeconds:
      started !== null && finished !== null
        ? Math.max(0, Math.round((finished.epochMilliseconds - started.epochMilliseconds) / 1000))
        : null,
    errorLines: errorLinesOf(parts.errorRows).slice(0, VIEW_ERROR_LINES),
    failureLines: parts.failedRows.slice(0, VIEW_FAILURE_LINES).map((row) => ({
      rowNumber: row.rowNumber,
      sku: row.summary.sku,
      code: row.runCode ?? 'row.failed',
    })),
    preview: parts.previewRows.slice(0, VIEW_PREVIEW_ROWS).map((row) => ({
      rowNumber: row.rowNumber,
      sku: row.summary.sku,
      title: row.summary.title,
      productCode: row.summary.productCode,
      typeCode: row.summary.typeCode,
      options: row.summary.options,
    })),
  };
}

/** The parts a job's view needs for its state: errors at the check, failures after a run, a preview. */
export async function loadSellerView(
  repository: SellerImportRepository,
  market: MarketContext,
  job: SellerImportJob,
  now: Temporal.Instant,
): Promise<SellerImportView> {
  const checking = job.state === 'checked';
  const ran = job.state === 'finished' || job.state === 'stopped';
  const [errorRows, failedRows, previewRows] = await Promise.all([
    checking && job.errorRows > 0
      ? repository.rows(
          market,
          job.id,
          { checkState: 'error' },
          { offset: 0, limit: VIEW_ERROR_LINES },
        )
      : [],
    ran && job.failedRows > 0
      ? repository.rows(
          market,
          job.id,
          { runState: 'failed' },
          { offset: 0, limit: VIEW_FAILURE_LINES },
        )
      : [],
    checking
      ? repository.rows(
          market,
          job.id,
          { checkState: 'ready' },
          { offset: 0, limit: VIEW_PREVIEW_ROWS },
        )
      : [],
  ]);
  return sellerViewOf(job, { errorRows, failedRows, previewRows }, now);
}

/**
 * A discarded job is never read again, so it does not wait for the retention: once its file is
 * gone, the job and its rows are deleted, in a unit of their own, after the unit that discarded it.
 */
export async function dropDiscardedSellerJobs(
  deps: {
    readonly unitOfWork: UnitOfWork;
    readonly sellerJobs: SellerImportRepository;
    readonly importFiles: ImportFileStore;
  },
  market: MarketContext,
  jobs: readonly { readonly id: Id<'SellerImport'>; readonly fileKey: string }[],
  now: Temporal.Instant,
): Promise<void> {
  for (const job of jobs) {
    try {
      await deps.importFiles.delete(job.fileKey);
      await deps.unitOfWork.run(market, async () => {
        await deps.sellerJobs.markFileDeleted(market, job.id, now);
        await deps.sellerJobs.deleteDiscarded(market, { ids: [job.id] });
        return ok(undefined);
      });
    } catch {
      // The row and the file stay for the purge job.
    }
  }
}

export interface SellerCheckEnvironmentDependencies extends CheckEnvironmentDependencies {
  readonly policy: CheckEnvironmentDependencies['policy'];
}

/** The environment of a check or a run: the Market's facts plus the seller's allowed types. */
export async function readSellerCheckEnvironment(
  deps: SellerCheckEnvironmentDependencies,
  market: MarketContext,
  allowedTypes: SellerCheckEnvironment['allowedTypes'],
): Promise<Result<SellerCheckEnvironment, CheckEnvironmentFailure>> {
  const base = await readCheckEnvironment(deps, market);
  if (!base.ok) return base;
  try {
    return ok({
      ...base.value,
      conditions: deps.policy.conditions(market),
      maxVariantsPerProduct: deps.policy.maxVariantsPerProduct(market),
      maxVariantAttributes: deps.policy.maxVariantAttributes(market),
      allowedTypes,
    });
  } catch {
    return { ok: false, error: { code: 'access.unavailable' } };
  }
}
