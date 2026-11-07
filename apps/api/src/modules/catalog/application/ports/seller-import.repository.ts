import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  SellerImportJob,
  SellerRowRecord,
  SellerRowRunState,
  SellerStopReason,
} from '../../domain/seller-import/seller-import-job';

/** A job to store with its checked rows, as the check step leaves them. */
export type NewSellerImportJob = Omit<
  SellerImportJob,
  | 'startedAt'
  | 'finishedAt'
  | 'endedAt'
  | 'skipErrors'
  | 'toImport'
  | 'createdRows'
  | 'updatedRows'
  | 'unchangedRows'
  | 'failedRows'
  | 'stopReason'
  | 'notBefore'
  | 'leaseUntil'
  | 'fileDeletedAt'
  | 'version'
  | 'state'
>;

export type SellerRowFilter = {
  readonly checkState?: 'ready' | 'error';
  readonly runState?: SellerRowRunState;
};

export type SellerGroupOutcome =
  | {
      readonly state: 'created' | 'updated' | 'unchanged';
      readonly productId: string | null;
      readonly offerId: string | null;
      readonly productCode: string | null;
    }
  | { readonly state: 'failed'; readonly code: string };

/**
 * Thrown by `confirm` and `resume` when the one-queued-or-running-import-per-seller index refuses
 * the write (two starts at once): the use case answers `import.already-running`.
 */
export class SellerImportAlreadyRunningError extends Error {
  constructor() {
    super('seller import already queued or running');
    this.name = 'SellerImportAlreadyRunningError';
  }
}

export interface NewSellerImportPhoto {
  readonly jobId: Id<'SellerImport'>;
  readonly nameKey: string;
  readonly productId: string;
  readonly addedAt: Temporal.Instant;
}

/**
 * The store of the seller import jobs (catalog data design 3.31). Every method runs in the open unit
 * of the caller, through the Market-scoped client; a write of a state is a conditional update that
 * answers whether it applied, so two runners or a double click never both win. A read that can
 * reach a job from a request takes the seller, so another seller's job is absent.
 */
export interface SellerImportRepository {
  add(
    market: MarketContext,
    job: NewSellerImportJob,
    rows: readonly SellerRowRecord[],
  ): Promise<void>;

  /** The job, or null; `sellerId` is checked here so another seller's job is absent. */
  find(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    id: Id<'SellerImport'>,
  ): Promise<SellerImportJob | null>;

  /** Whether the seller has an import that is queued or running (the one-running rule). */
  hasActive(market: MarketContext, sellerId: Id<'Seller'>): Promise<boolean>;

  /** The seller's newest job that is not discarded, or null. */
  latestOf(market: MarketContext, sellerId: Id<'Seller'>): Promise<SellerImportJob | null>;

  /**
   * Discards the account's `checked` jobs (a new upload replaces them); answers the stored file
   * keys so the caller can delete the files after the unit.
   */
  discardChecked(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    accountId: Id<'Account'>,
    now: Temporal.Instant,
  ): Promise<readonly { readonly id: Id<'SellerImport'>; readonly fileKey: string }[]>;

  rows(
    market: MarketContext,
    id: Id<'SellerImport'>,
    filter: SellerRowFilter,
    page: { readonly offset: number; readonly limit: number },
  ): Promise<readonly SellerRowRecord[]>;

  /** `checked` to `queued`; error rows become `skipped`. False when the job was not `checked`. */
  confirm(
    market: MarketContext,
    id: Id<'SellerImport'>,
    choice: {
      readonly skipErrors: boolean;
      readonly toImport: number;
      readonly now: Temporal.Instant;
    },
  ): Promise<boolean>;

  /** `stopped` to `queued`. False when the job was not `stopped`. */
  resume(market: MarketContext, id: Id<'SellerImport'>): Promise<boolean>;

  /** `checked` to `discarded`; answers the file key to delete, or null when it was not `checked`. */
  discard(
    market: MarketContext,
    id: Id<'SellerImport'>,
    now: Temporal.Instant,
  ): Promise<{ readonly fileKey: string } | null>;

  claim(
    market: MarketContext,
    now: Temporal.Instant,
    leaseUntil: Temporal.Instant,
  ): Promise<SellerImportJob | null>;

  renewLease(
    market: MarketContext,
    id: Id<'SellerImport'>,
    leaseUntil: Temporal.Instant,
  ): Promise<boolean>;

  /**
   * The next ready and `pending` rows of a running job in file order: at least `limit` rows, then
   * the rest of the last group, so a group is never split across two batches.
   */
  pendingRows(
    market: MarketContext,
    id: Id<'SellerImport'>,
    limit: number,
  ): Promise<readonly SellerRowRecord[]>;

  /** Remembers the product and Offer of a group the moment they exist, so a retry never creates a second. */
  recordGroup(
    market: MarketContext,
    id: Id<'SellerImport'>,
    groupRow: number,
    record: {
      readonly productId: string | null;
      readonly offerId: string | null;
      readonly productCode: string | null;
    },
  ): Promise<void>;

  /** Settles the pending rows of a group and moves the job's counters in the same unit. */
  settleGroup(
    market: MarketContext,
    id: Id<'SellerImport'>,
    groupRow: number,
    outcome: SellerGroupOutcome,
  ): Promise<number>;

  /** Fails every ready and pending row with one code (the seller lost the right to sell). */
  failRemaining(market: MarketContext, id: Id<'SellerImport'>, code: string): Promise<number>;

  endTurn(
    market: MarketContext,
    id: Id<'SellerImport'>,
    next:
      | { readonly state: 'queued'; readonly notBefore: Temporal.Instant | null }
      | { readonly state: 'finished'; readonly now: Temporal.Instant }
      | {
          readonly state: 'stopped';
          readonly reason: SellerStopReason;
          readonly now: Temporal.Instant;
        },
  ): Promise<number | null>;

  filesDue(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<readonly { readonly id: Id<'SellerImport'>; readonly fileKey: string }[]>;

  markFileDeleted(
    market: MarketContext,
    id: Id<'SellerImport'>,
    now: Temporal.Instant,
  ): Promise<void>;

  deleteSettledBefore(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<number>;

  deleteDiscarded(
    market: MarketContext,
    scope: { readonly ids: readonly Id<'SellerImport'>[] } | { readonly limit: number },
  ): Promise<number>;

  /**
   * The imports the seller confirmed since an instant, oldest first, each with its start and its
   * row count (the daily row cap, design 14c: their sum, and when enough of them age out).
   */
  startsSince(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    since: Temporal.Instant,
  ): Promise<readonly { readonly startedAt: Temporal.Instant; readonly toImport: number }[]>;

  /**
   * The product of the settled group that listed this photo name (the lower-cased key), or null: one
   * indexed lookup of the name, never a read of every row.
   */
  photoTarget(
    market: MarketContext,
    id: Id<'SellerImport'>,
    nameKey: string,
  ): Promise<string | null>;

  /**
   * Reserves the name for one photo before the upload (no image yet): false when the name already
   * has a photo or a live reservation. A reservation older than `staleBefore` that never got its
   * image (a crash between the reservation and the upload) is taken over.
   */
  reservePhoto(
    market: MarketContext,
    photo: NewSellerImportPhoto,
    staleBefore: Temporal.Instant,
  ): Promise<boolean>;

  /** Sets the image of a reserved name, once; false when the name has no open reservation. */
  setPhotoImage(
    market: MarketContext,
    id: Id<'SellerImport'>,
    nameKey: string,
    imageId: string,
  ): Promise<boolean>;

  /** Drops a reservation that got no image (the upload or the save failed). */
  releasePhoto(market: MarketContext, id: Id<'SellerImport'>, nameKey: string): Promise<void>;

  /** The name keys already added in the job. */
  photoNames(market: MarketContext, id: Id<'SellerImport'>): Promise<ReadonlySet<string>>;
}

export const SELLER_IMPORT_REPOSITORY = Symbol('CATALOG_SELLER_IMPORT_REPOSITORY');
