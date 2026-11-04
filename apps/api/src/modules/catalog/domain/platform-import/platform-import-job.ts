import type { Id, Temporal } from '@mondapac/shared-kernel';
import type { IgnoredColumn } from './columns';
import type { ImportFormat } from './import-file';
import type { RowIssue, RowSummary } from './row-check';

// The platform import job (catalog design 14a): the record of one admin's file from its check to
// its report. Plain data and pure rules; the store moves it between states with conditional writes.

/**
 * `checked`: the file was read and checked, nothing else happened. `queued`: confirmed, waiting for
 * the worker (or waiting out a rate window). `running`: the worker holds it. `finished`: every row
 * the run took was tried. `stopped`: the run ended part way and can be resumed. `discarded`: the
 * admin left or replaced the file, or the retention removed an unconfirmed check.
 */
export const IMPORT_JOB_STATES = [
  'checked',
  'queued',
  'running',
  'finished',
  'stopped',
  'discarded',
] as const;
export type ImportJobState = (typeof IMPORT_JOB_STATES)[number];

/** What the admin chose in "New products start as" (design 14a, 4.1a). */
export const START_AS = ['inactive', 'active'] as const;
export type StartAs = (typeof START_AS)[number];

/** Why a run ended part way. `pause-failed`: a product was published but could not be made Inactive. */
export const STOP_REASONS = [
  'rate-limited',
  'access-lost',
  'pause-failed',
  'file-missing',
  'unexpected',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export type RowRunState = 'pending' | 'added' | 'failed' | 'skipped';

export interface ImportJob {
  readonly id: Id<'PlatformImport'>;
  /** The job identity: the admin who started it and the session they started it in (ids, never a token). */
  readonly startedByAccountId: Id<'Account'>;
  readonly startedBySessionId: Id<'Session'>;
  readonly state: ImportJobState;
  readonly format: ImportFormat;
  /** The name the admin sent, cleaned by {@link fileLabelOf}. */
  readonly fileLabel: string;
  readonly fileKey: string;
  /** Lower-case hex of the SHA-256 of the file. */
  readonly fileSha256: string;
  readonly fileBytes: number;
  readonly fileDeletedAt: Temporal.Instant | null;
  readonly totalRows: number;
  readonly readyRows: number;
  readonly errorRows: number;
  readonly warningRows: number;
  readonly ignoredColumns: readonly IgnoredColumn[];
  readonly startAs: StartAs | null;
  readonly skipErrors: boolean | null;
  readonly toImport: number | null;
  readonly addedRows: number;
  readonly failedRows: number;
  readonly stopReason: StopReason | null;
  readonly notBefore: Temporal.Instant | null;
  readonly leaseUntil: Temporal.Instant | null;
  readonly version: number;
  readonly createdAt: Temporal.Instant;
  readonly checkedAt: Temporal.Instant;
  readonly startedAt: Temporal.Instant | null;
  readonly finishedAt: Temporal.Instant | null;
}

/** One row of the job as stored: the check result and, once run, its outcome. */
export interface ImportRowRecord {
  readonly rowNumber: number;
  readonly checkState: 'ready' | 'error';
  readonly issues: readonly RowIssue[];
  readonly summary: RowSummary;
  readonly runState: RowRunState;
  readonly runCode: string | null;
  readonly productId: string | null;
  readonly productCode: string | null;
}

/** The most issues kept for one row (the table's CHECK). */
export const MAX_ISSUES_PER_ROW = 12;

/** The longest a stored file label is. */
export const FILE_LABEL_MAX = 80;

/**
 * The name an upload is shown under. It is never echoed as sent: only letters, digits, spaces and
 * `. _ ( ) -` stay, the rest becomes a space, the length is capped and a name with nothing left
 * becomes `import`. The path of a client (`C:\\x\\a.csv`) is cut to its last part.
 */
export function fileLabelOf(name: unknown): string {
  if (typeof name !== 'string') return 'import';
  const last = name.split(/[\\/]/).at(-1) ?? '';
  const clean = last
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} ._()-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FILE_LABEL_MAX)
    .trim();
  return clean === '' ? 'import' : clean;
}

/** True when the job can still be confirmed: checked, with at least one ready row. */
export function canConfirm(job: Pick<ImportJob, 'state' | 'readyRows'>): boolean {
  return job.state === 'checked' && job.readyRows > 0;
}

/** True when the rows with errors may be left out only by the admin's explicit choice. */
export function mustSkipErrors(job: Pick<ImportJob, 'errorRows'>): boolean {
  return job.errorRows > 0;
}

/** The rows a confirmed run will try: every ready row (error rows are skipped, never tried). */
export function rowsToImport(job: Pick<ImportJob, 'readyRows'>): number {
  return job.readyRows;
}

/** True when a state is the end of the road for the page's polling. */
export function isSettled(state: ImportJobState): boolean {
  return state === 'finished' || state === 'stopped' || state === 'discarded';
}
