import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

// The store behind "Move products" (categories package C5a, decision 8): one job moves every
// published product of category X to category Y, one item per product. Every method runs in the
// caller's unit through the Market-scoped client. Jobs and items are never deleted.

export type MoveJobState = 'queued' | 'running' | 'done' | 'failed';
export type MoveItemState = 'pending' | 'moved' | 'skipped' | 'failed';

export interface MoveJobRecord {
  readonly id: Id<'CategoryMoveJob'>;
  readonly sourceCategoryId: Id<'Category'>;
  readonly targetCategoryId: Id<'Category'>;
  /** The admin's reason note; never sent to a seller. */
  readonly reason: string;
  readonly state: MoveJobState;
  readonly createdByAccountId: Id<'Account'>;
  readonly createdAt: Temporal.Instant;
  readonly startedAt: Temporal.Instant | null;
  readonly finishedAt: Temporal.Instant | null;
  readonly cursorProductId: Id<'Product'> | null;
  readonly total: number;
  readonly moved: number;
  readonly skipped: number;
  readonly failed: number;
  readonly version: number;
}

/** What the progress read shows. */
export type MoveProgress = Pick<
  MoveJobRecord,
  | 'id'
  | 'sourceCategoryId'
  | 'targetCategoryId'
  | 'state'
  | 'createdAt'
  | 'startedAt'
  | 'finishedAt'
  | 'total'
  | 'moved'
  | 'skipped'
  | 'failed'
>;

export interface CategoryProductMoveStore {
  /** Published products whose published revision names the category. */
  countProducts(market: MarketContext, categoryId: Id<'Category'>): Promise<number>;

  /**
   * Inserts a queued job. False when the category already has a queued or running job (the
   * partial unique index; the loser of two starts gets false).
   */
  insertJob(
    market: MarketContext,
    job: {
      readonly id: Id<'CategoryMoveJob'>;
      readonly sourceCategoryId: Id<'Category'>;
      readonly targetCategoryId: Id<'Category'>;
      readonly reason: string;
      readonly createdByAccountId: Id<'Account'>;
      readonly total: number;
      readonly now: Temporal.Instant;
    },
  ): Promise<boolean>;

  find(market: MarketContext, id: Id<'CategoryMoveJob'>): Promise<MoveJobRecord | null>;

  /** The newest jobs of a source category, newest first. */
  listForSource(
    market: MarketContext,
    sourceCategoryId: Id<'Category'>,
    limit: number,
  ): Promise<readonly MoveJobRecord[]>;

  /**
   * Takes the oldest queued job, or a running one whose lease ran out, for `holder` until
   * `leaseUntil`; null when none is due. One conditional update; a second runner gets null.
   */
  claim(
    market: MarketContext,
    holder: string,
    now: Temporal.Instant,
    leaseUntil: Temporal.Instant,
  ): Promise<MoveJobRecord | null>;

  /** Extends the lease; false when the holder lost it. */
  renew(
    market: MarketContext,
    id: Id<'CategoryMoveJob'>,
    holder: string,
    leaseUntil: Temporal.Instant,
  ): Promise<boolean>;

  /**
   * The next products after the job's cursor whose published revision still names the source,
   * ascending by id, at most `limit`.
   */
  nextProducts(
    market: MarketContext,
    job: MoveJobRecord,
    limit: number,
  ): Promise<readonly Id<'Product'>[]>;

  /**
   * Writes the item of a product once. False when the job already has an item for it (a product
   * handled by an earlier turn): the caller then does not touch the product again.
   */
  recordItem(
    market: MarketContext,
    jobId: Id<'CategoryMoveJob'>,
    productId: Id<'Product'>,
    outcome:
      | { readonly state: 'moved'; readonly revisionId: Id<'ProductRevision'> }
      | { readonly state: 'skipped' | 'failed' },
    now: Temporal.Instant,
  ): Promise<boolean>;

  /** Moved items whose seller has not been told yet, at most `limit`. */
  unnotified(
    market: MarketContext,
    jobId: Id<'CategoryMoveJob'>,
    limit: number,
  ): Promise<readonly { readonly productId: Id<'Product'> }[]>;

  /** Marks the seller email of a moved item as sent. */
  markNotified(
    market: MarketContext,
    jobId: Id<'CategoryMoveJob'>,
    productId: Id<'Product'>,
    now: Temporal.Instant,
  ): Promise<void>;

  /**
   * Moves the cursor and adds the batch's counts under the lease. False when the holder no
   * longer holds the job.
   */
  advance(
    market: MarketContext,
    id: Id<'CategoryMoveJob'>,
    holder: string,
    step: {
      readonly cursor: Id<'Product'>;
      readonly moved: number;
      readonly skipped: number;
      readonly failed: number;
    },
  ): Promise<boolean>;

  /** Ends the job (`done`, or `failed` after an unrecoverable fault), releasing the lease. */
  finish(
    market: MarketContext,
    id: Id<'CategoryMoveJob'>,
    holder: string,
    state: 'done' | 'failed',
    now: Temporal.Instant,
  ): Promise<boolean>;
}

export const CATEGORY_PRODUCT_MOVE_STORE = Symbol('CATEGORY_PRODUCT_MOVE_STORE');
