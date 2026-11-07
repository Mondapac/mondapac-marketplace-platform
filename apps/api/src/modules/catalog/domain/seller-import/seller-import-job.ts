import type { Id, Temporal } from '@mondapac/shared-kernel';
import type { ImportFormat } from '../platform-import/import-file';
import type { ImportJobState } from '../import-jobs/import-job-core';
import type { SellerImportMode, SellerIgnoredColumn } from './columns';
import type { SellerRowIssue, SellerRowSummary } from './row-check';

// The seller import job (catalog design 14c): the record of one seller's file from its check to its
// report. Plain data; the store moves it between states with conditional writes. The shared parts
// (states, label, limits) are the job core of `import-jobs`.

/** Why a run ended part way (design 14c). */
export const SELLER_STOP_REASONS = [
  'rate-limited',
  'access-lost',
  'seller-not-eligible',
  'file-missing',
  'unexpected',
] as const;
export type SellerStopReason = (typeof SELLER_STOP_REASONS)[number];

export type SellerRowRunState =
  'pending' | 'created' | 'updated' | 'unchanged' | 'failed' | 'skipped';

export interface SellerImportJob {
  readonly id: Id<'SellerImport'>;
  readonly sellerId: Id<'Seller'>;
  /** The job identity: the account and the session that started the import (ids, never a token). */
  readonly startedByAccountId: Id<'Account'>;
  readonly startedBySessionId: Id<'Session'>;
  readonly mode: SellerImportMode;
  readonly state: ImportJobState;
  readonly format: ImportFormat;
  readonly fileLabel: string;
  readonly fileKey: string;
  readonly fileSha256: string;
  readonly fileBytes: number;
  readonly fileDeletedAt: Temporal.Instant | null;
  readonly totalRows: number;
  readonly readyRows: number;
  readonly errorRows: number;
  readonly warningRows: number;
  readonly groupCount: number;
  readonly ignoredColumns: readonly SellerIgnoredColumn[];
  readonly skipErrors: boolean | null;
  readonly toImport: number | null;
  readonly createdRows: number;
  readonly updatedRows: number;
  readonly unchangedRows: number;
  readonly failedRows: number;
  readonly stopReason: SellerStopReason | null;
  readonly notBefore: Temporal.Instant | null;
  readonly leaseUntil: Temporal.Instant | null;
  readonly version: number;
  readonly createdAt: Temporal.Instant;
  readonly checkedAt: Temporal.Instant;
  readonly startedAt: Temporal.Instant | null;
  readonly finishedAt: Temporal.Instant | null;
}

/** One row of the job as stored: the check result and, once run, its outcome. */
export interface SellerRowRecord {
  readonly rowNumber: number;
  readonly groupRow: number;
  readonly checkState: 'ready' | 'error';
  readonly plan: 'create' | 'update' | null;
  readonly issues: readonly SellerRowIssue[];
  readonly summary: SellerRowSummary;
  readonly runState: SellerRowRunState;
  readonly runCode: string | null;
  readonly productId: string | null;
  readonly offerId: string | null;
  readonly productCode: string | null;
}

/** The photo step can add photos for this long after a run ends (design 14c). */
export const PHOTO_WINDOW_DAYS = 7;
