import type { ImportJob, ImportRowRecord } from '../../domain/platform-import/platform-import-job';

/** How many lines of errors and of failures a page of the view carries; the report has them all. */
export const VIEW_ERROR_LINES = 100;
export const VIEW_FAILURE_LINES = 100;
export const VIEW_PREVIEW_ROWS = 5;

/** One problem line of the error table (design: row, column, value, problem). */
export interface ImportErrorLine {
  readonly rowNumber: number;
  readonly column: string;
  readonly code: string;
  readonly value: string;
  readonly otherRow: number | null;
}

/** One row that was not imported, with its reason. */
export interface ImportFailureLine {
  readonly rowNumber: number;
  readonly title: string;
  readonly code: string;
}

export interface ImportPreviewRow {
  readonly rowNumber: number;
  readonly title: string;
  readonly category: string;
  readonly typeCode: string;
  readonly brand: string;
}

/** What the page shows of a job: counts, state, and the lines each step needs. Ids and codes; no file content beyond the cleaned cells. */
export interface ImportView {
  readonly id: string;
  readonly state: ImportJob['state'];
  readonly fileLabel: string;
  readonly fileBytes: number;
  readonly format: ImportJob['format'];
  readonly rows: number;
  readonly ready: number;
  readonly errors: number;
  readonly warnings: number;
  readonly ignoredColumns: ImportJob['ignoredColumns'];
  readonly startAs: ImportJob['startAs'];
  readonly skipErrors: boolean | null;
  readonly toImport: number | null;
  readonly added: number;
  readonly failed: number;
  readonly stopReason: ImportJob['stopReason'];
  /** A resumed or finished run still has its file; a purged file ends the chance to resume. */
  readonly canResume: boolean;
  readonly checkedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** Seconds from start to finish (or to now for a running job is the page's to show). */
  readonly durationSeconds: number | null;
  readonly errorLines: readonly ImportErrorLine[];
  readonly failureLines: readonly ImportFailureLine[];
  readonly preview: readonly ImportPreviewRow[];
}

/** The error table's lines: every error issue of the rows with errors, in file order. */
export function errorLinesOf(rows: readonly ImportRowRecord[]): ImportErrorLine[] {
  const lines: ImportErrorLine[] = [];
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

/**
 * The view of a job. `errorRows`, `failedRows` and `readyRows` are what the caller read (a bounded
 * page of each), so the view never walks a 5,000-row file.
 */
export function viewOf(
  job: ImportJob,
  parts: {
    readonly errorRows: readonly ImportRowRecord[];
    readonly failedRows: readonly ImportRowRecord[];
    readonly previewRows: readonly ImportRowRecord[];
  },
): ImportView {
  const started = job.startedAt;
  const finished = job.finishedAt;
  return {
    id: job.id,
    state: job.state,
    fileLabel: job.fileLabel,
    fileBytes: job.fileBytes,
    format: job.format,
    rows: job.totalRows,
    ready: job.readyRows,
    errors: job.errorRows,
    warnings: job.warningRows,
    ignoredColumns: job.ignoredColumns,
    startAs: job.startAs,
    skipErrors: job.skipErrors,
    toImport: job.toImport,
    added: job.addedRows,
    failed: job.failedRows,
    stopReason: job.stopReason,
    canResume: job.state === 'stopped' && job.fileDeletedAt === null,
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
      title: row.summary.title,
      code: row.runCode ?? 'row.failed',
    })),
    preview: parts.previewRows.slice(0, VIEW_PREVIEW_ROWS).map((row) => ({
      rowNumber: row.rowNumber,
      title: row.summary.title,
      category: row.summary.category,
      typeCode: row.summary.typeCode,
      brand: row.summary.brand,
    })),
  };
}
