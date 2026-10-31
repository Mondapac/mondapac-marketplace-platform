import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  ImportJob,
  ImportRowRecord,
  RowRunState,
  StartAs,
  StopReason,
} from '../../domain/platform-import/platform-import-job';

/** A job to store with its checked rows, as the check step leaves them. */
export type NewImportJob = Omit<
  ImportJob,
  | 'startedAt'
  | 'finishedAt'
  | 'startAs'
  | 'skipErrors'
  | 'toImport'
  | 'addedRows'
  | 'failedRows'
  | 'stopReason'
  | 'notBefore'
  | 'leaseUntil'
  | 'fileDeletedAt'
  | 'version'
  | 'state'
>;

export type RowFilter = {
  readonly checkState?: 'ready' | 'error';
  readonly runState?: RowRunState;
};

/**
 * The store of the platform import jobs (catalog data design 3.29). Every method runs in the open
 * unit of the caller, through the Market-scoped client; a write of a state is a conditional update
 * that answers whether it applied, so two runners or a double click never both win.
 */
export interface PlatformImportRepository {
  /** Stores a checked job and its rows (state `checked`, version 1). */
  add(market: MarketContext, job: NewImportJob, rows: readonly ImportRowRecord[]): Promise<void>;

  find(market: MarketContext, id: Id<'PlatformImport'>): Promise<ImportJob | null>;

  /** Whether the admin has an import that is queued or running (the one-running rule). */
  hasActive(market: MarketContext, accountId: Id<'Account'>): Promise<boolean>;

  /** The admin's newest job that is not discarded, or null. */
  latestOf(market: MarketContext, accountId: Id<'Account'>): Promise<ImportJob | null>;

  /**
   * Discards the admin's `checked` jobs (a new upload replaces them); answers the stored file keys
   * so the caller can delete the files after the unit.
   */
  discardChecked(
    market: MarketContext,
    accountId: Id<'Account'>,
    now: Temporal.Instant,
  ): Promise<readonly { readonly id: Id<'PlatformImport'>; readonly fileKey: string }[]>;

  /** Rows in file order. */
  rows(
    market: MarketContext,
    id: Id<'PlatformImport'>,
    filter: RowFilter,
    page: { readonly offset: number; readonly limit: number },
  ): Promise<readonly ImportRowRecord[]>;

  /** `checked` to `queued` with the admin's choice; error rows become `skipped`. False when the job was not `checked`. */
  confirm(
    market: MarketContext,
    id: Id<'PlatformImport'>,
    choice: {
      readonly startAs: StartAs;
      readonly skipErrors: boolean;
      readonly toImport: number;
      readonly now: Temporal.Instant;
    },
  ): Promise<boolean>;

  /** `stopped` to `queued` (the rest of the rows run again). False when the job was not `stopped`. */
  resume(market: MarketContext, id: Id<'PlatformImport'>): Promise<boolean>;

  /** `checked` to `discarded`; answers the file key to delete, or null when the job was not `checked`. */
  discard(
    market: MarketContext,
    id: Id<'PlatformImport'>,
    now: Temporal.Instant,
  ): Promise<{ readonly fileKey: string } | null>;

  /**
   * Takes the oldest job that is due: `queued` with `notBefore` passed, or `running` whose lease
   * ended (its runner died). Sets it `running` with the lease. Null when nothing is due.
   */
  claim(
    market: MarketContext,
    now: Temporal.Instant,
    leaseUntil: Temporal.Instant,
  ): Promise<ImportJob | null>;

  /** Pushes the lease of a running job. False when the job is no longer running. */
  renewLease(
    market: MarketContext,
    id: Id<'PlatformImport'>,
    leaseUntil: Temporal.Instant,
  ): Promise<boolean>;

  /** The next rows of a running job that are ready and still `pending`, in file order. */
  pendingRows(
    market: MarketContext,
    id: Id<'PlatformImport'>,
    limit: number,
  ): Promise<readonly ImportRowRecord[]>;

  /** Remembers the product of a row the moment it exists, so a retry never creates a second one. */
  recordProduct(
    market: MarketContext,
    id: Id<'PlatformImport'>,
    rowNumber: number,
    product: { readonly productId: string; readonly productCode: string },
  ): Promise<void>;

  /** Settles a row (`added` or `failed`) and moves the job's counter in the same unit. */
  settleRow(
    market: MarketContext,
    id: Id<'PlatformImport'>,
    rowNumber: number,
    outcome:
      | { readonly state: 'added'; readonly productId: string; readonly productCode: string }
      | { readonly state: 'failed'; readonly code: string },
  ): Promise<void>;

  /**
   * Ends a run's turn: back to `queued` (more to do, maybe after `notBefore`), or `finished`, or
   * `stopped` with a reason. Raises the version and answers the new one. Null when the job was not
   * `running`.
   */
  endTurn(
    market: MarketContext,
    id: Id<'PlatformImport'>,
    next:
      | { readonly state: 'queued'; readonly notBefore: Temporal.Instant | null }
      | { readonly state: 'finished'; readonly now: Temporal.Instant }
      | { readonly state: 'stopped'; readonly reason: StopReason },
  ): Promise<number | null>;

  /** The files still stored of jobs checked before `before`, for the purge. */
  filesDue(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<readonly { readonly id: Id<'PlatformImport'>; readonly fileKey: string }[]>;

  markFileDeleted(
    market: MarketContext,
    id: Id<'PlatformImport'>,
    now: Temporal.Instant,
  ): Promise<void>;

  /** Deletes the jobs created before `before` that are finished, stopped or discarded, with their rows; answers how many. */
  deleteSettledBefore(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<number>;
}

export const PLATFORM_IMPORT_REPOSITORY = Symbol('CATALOG_PLATFORM_IMPORT_REPOSITORY');
