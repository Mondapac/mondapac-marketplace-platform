import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { ProductCategoryNode } from '../../domain/product-category-rules';

// The store behind "Move products" (categories package C5a, decision 8): one job moves every
// published product of category X to category Y, one item per product. Every method runs in the
// caller's unit through the Market-scoped client. Jobs and items are never deleted.

export type MoveJobState = 'queued' | 'running' | 'done' | 'failed';
export type MoveItemState = 'pending' | 'moved' | 'skipped' | 'failed';
/** How the job's one product pass ended. */
export type MoveScanOutcome = 'done' | 'failed';

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
  /**
   * Set once, when the product pass ended (N1): `done` at the first empty scan, `failed` when the
   * tree could not be read. A later turn only drains the seller notices and ends the job in this
   * state; it never scans products again, so a product published into the source after the pass
   * is not moved.
   */
  readonly scanOutcome: MoveScanOutcome | null;
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
   * handled by an earlier turn): the caller then does not touch the product again. A duplicate is
   * not an error (no failed statement), so the caller's unit stays usable after a false.
   * A product about to be moved is recorded `pending` (no revision yet: the item's foreign key
   * names a revision that must exist) and turned `moved` by {@link markMoved} in the same unit.
   */
  recordItem(
    market: MarketContext,
    jobId: Id<'CategoryMoveJob'>,
    productId: Id<'Product'>,
    outcome: { readonly state: 'pending' | 'skipped' | 'failed' },
    now: Temporal.Instant,
  ): Promise<boolean>;

  /**
   * Turns the `pending` item of a product `moved`, naming the revision the move published (written
   * before this call in the same unit). False when there is no pending item.
   */
  markMoved(
    market: MarketContext,
    jobId: Id<'CategoryMoveJob'>,
    productId: Id<'Product'>,
    revisionId: Id<'ProductRevision'>,
  ): Promise<boolean>;

  /**
   * The category and its ancestors as they are now (status and parent), read fresh in the
   * caller's unit; empty when the category is not in this Market. Used to re-check the target
   * for every product, so a target archived or moved mid-job fails the item, not the job.
   */
  categoryChain(
    market: MarketContext,
    categoryId: Id<'Category'>,
  ): Promise<readonly ProductCategoryNode[]>;

  /**
   * Moved items whose seller has not been told, whose email is not given up and whose retry (if
   * any) is due at `now`, at most `limit`, with the failed sends so far.
   */
  unnotified(
    market: MarketContext,
    jobId: Id<'CategoryMoveJob'>,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly { readonly productId: Id<'Product'>; readonly attempts: number }[]>;

  /** True while a moved item's seller email is neither sent nor given up (due or waiting). */
  hasOpenNotices(market: MarketContext, jobId: Id<'CategoryMoveJob'>): Promise<boolean>;

  /** Marks the seller email of a moved item as sent. */
  markNotified(
    market: MarketContext,
    jobId: Id<'CategoryMoveJob'>,
    productId: Id<'Product'>,
    now: Temporal.Instant,
  ): Promise<void>;

  /**
   * Records a failed send of a moved item's email (N1): the attempts so far and when to try it
   * again, or, with `nextAttemptAt` null (the last attempt), gives it up at `now` so the job can
   * end. Only an open notice changes.
   */
  noticeFailed(
    market: MarketContext,
    jobId: Id<'CategoryMoveJob'>,
    productId: Id<'Product'>,
    outcome: { readonly attempts: number; readonly nextAttemptAt: Temporal.Instant | null },
    now: Temporal.Instant,
  ): Promise<void>;

  /**
   * Moves the cursor under the lease and sets the counters from the job's items (counted by
   * state, never accumulated by the runner, so a turn that lost its lease cannot under- or
   * over-count; a committed `pending` item counts as failed). False when the holder no longer
   * holds the job.
   */
  advance(
    market: MarketContext,
    id: Id<'CategoryMoveJob'>,
    holder: string,
    cursor: Id<'Product'>,
  ): Promise<boolean>;

  /**
   * Records, under the lease, that the job's product pass ended ({@link MoveJobRecord.scanOutcome})
   * and sets the counters from the items, as in {@link advance}. Written once: false when the
   * holder no longer holds the job or the pass was already ended.
   */
  endScan(
    market: MarketContext,
    id: Id<'CategoryMoveJob'>,
    holder: string,
    outcome: MoveScanOutcome,
  ): Promise<boolean>;

  /**
   * Ends the job (`done`, or `failed` after an unrecoverable fault), releasing the lease; the
   * counters are set from the items, as in {@link advance}. An item still `pending` (a product unit
   * that committed without its revision, which the run never does) is turned `failed` first and
   * counted as failed (N2): no handled product drops out of the counters.
   */
  finish(
    market: MarketContext,
    id: Id<'CategoryMoveJob'>,
    holder: string,
    state: 'done' | 'failed',
    now: Temporal.Instant,
  ): Promise<boolean>;
}

export const CATEGORY_PRODUCT_MOVE_STORE = Symbol('CATEGORY_PRODUCT_MOVE_STORE');
