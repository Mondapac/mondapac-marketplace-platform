import type { Id, Temporal } from '@mondapac/shared-kernel';
import type { IgnoredColumn } from './columns';
import type { ImportFormat } from './import-file';
import type { RowIssue, RowSummary } from './row-check';
import {
  canConfirm as coreCanConfirm,
  fileLabelOf,
  FILE_LABEL_MAX,
  IMPORT_JOB_STATES,
  isSettled,
  MAX_ISSUES_PER_ROW,
  mustSkipErrors as coreMustSkipErrors,
  type ImportJobState,
} from '../import-jobs/import-job-core';

// The states, the label and the row limit are the job core the seller import (14c) shares.
export { fileLabelOf, FILE_LABEL_MAX, IMPORT_JOB_STATES, isSettled, MAX_ISSUES_PER_ROW };
export type { ImportJobState };

// The platform import job (catalog design 14a): the record of one admin's file from its check to
// its report. Plain data and pure rules; the store moves it between states with conditional writes.

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

/** True when the job can still be confirmed: checked, with at least one ready row. */
export const canConfirm = (job: Pick<ImportJob, 'state' | 'readyRows'>): boolean =>
  coreCanConfirm(job);

/** True when the rows with errors may be left out only by the admin's explicit choice. */
export const mustSkipErrors = (job: Pick<ImportJob, 'errorRows'>): boolean =>
  coreMustSkipErrors(job);

/** The rows a confirmed run will try: every ready row (error rows are skipped, never tried). */
export function rowsToImport(job: Pick<ImportJob, 'readyRows'>): number {
  return job.readyRows;
}
