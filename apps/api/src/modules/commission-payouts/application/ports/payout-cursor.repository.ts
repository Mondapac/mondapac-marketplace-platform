import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { BlockReason } from '../../domain/payout';

/** Where one seller is in the payout schedule, and the seller's money lock. */
export interface PayoutCursor {
  readonly sellerId: Id<'Seller'>;
  /** The last slot a payout (or a decision not to pay) answered; only moves forward. */
  readonly lastSlotAt: Temporal.Instant;
  /** The next instant the run looks at this seller; null until it has worked one out. */
  readonly nextSlotAt: Temporal.Instant | null;
  readonly zone: string | null;
  /** Why the last evaluation did not pay; null when nothing blocked. */
  readonly blockReason: BlockReason | null;
  readonly evaluatedAt: Temporal.Instant | null;
  readonly updatedAt: Temporal.Instant;
  readonly version: number;
}

/** What a run writes back; `lastSlotAt` may only grow. */
export interface CursorUpdate {
  readonly lastSlotAt: Temporal.Instant;
  readonly nextSlotAt: Temporal.Instant | null;
  readonly zone: string | null;
  readonly blockReason: BlockReason | null;
  readonly evaluatedAt: Temporal.Instant;
}

/**
 * The payout schedule cursors of one Market (`commission_payouts.payout_schedule_cursors`), one
 * row per seller. Every unit that moves a seller's money locks this row first.
 */
export interface PayoutCursorRepository {
  /** Creates the seller's cursor at `now` unless it exists (the first anchor); nothing is due before it. */
  ensure(market: MarketContext, sellerId: Id<'Seller'>, now: Temporal.Instant): Promise<void>;

  /**
   * Takes the row lock (a version bump) and answers the cursor, or null when the seller has none.
   * The lock lasts until the unit ends.
   */
  lock(market: MarketContext, sellerId: Id<'Seller'>): Promise<PayoutCursor | null>;

  find(market: MarketContext, sellerId: Id<'Seller'>): Promise<PayoutCursor | null>;

  /** Writes the update to the cursor the unit holds the lock of. */
  save(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    update: CursorUpdate,
    now: Temporal.Instant,
  ): Promise<void>;

  /** Sellers due at `now`: a slot reached, or never worked out / not worked out since `staleBefore`. */
  listDue(
    market: MarketContext,
    now: Temporal.Instant,
    staleBefore: Temporal.Instant,
    limit: number,
  ): Promise<readonly PayoutCursor[]>;

  /** The seller's terms changed: the next slot is worked out again at the next run. */
  invalidate(market: MarketContext, sellerId: Id<'Seller'>, now: Temporal.Instant): Promise<void>;
}

export const PAYOUT_CURSOR_REPOSITORY = Symbol('PAYOUT_CURSOR_REPOSITORY');
