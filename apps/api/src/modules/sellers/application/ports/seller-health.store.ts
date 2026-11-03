import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { SellerHealth, SellerHealthInput } from '../../domain/seller-health';
import type { SellerHealthDay } from '../../domain/seller-health-days';

/** The daily snapshot of one seller's score, as stored (data: sellers.seller_health_snapshots). */
export interface SellerHealthSnapshot {
  readonly day: Temporal.PlainDate;
  readonly health: SellerHealth;
  /** The counts the score was computed from, kept for the card and for tracing a formula change. */
  readonly inputs: SellerHealthInput;
  readonly computedAt: Temporal.Instant;
}

/**
 * `sellers.seller_health_days` and `sellers.seller_health_snapshots`. Runs in the caller's open
 * read-write unit. A day or snapshot written again for the same seller and local day replaces
 * the earlier one, so a repeat or a recalculation never counts twice.
 */
export interface SellerHealthStore {
  /** Sets the counters of one local day (the whole row). */
  saveDay(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    day: SellerHealthDay,
    recountedAt: Temporal.Instant,
  ): Promise<void>;

  /** The seller's counters for the dates from `from` to `to`, both included. */
  days(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    from: Temporal.PlainDate,
    to: Temporal.PlainDate,
  ): Promise<readonly SellerHealthDay[]>;

  saveSnapshot(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    snapshot: SellerHealthSnapshot,
  ): Promise<void>;

  /** The seller's snapshots from `from` to `to`, oldest first (the 90-day trend). */
  snapshots(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    from: Temporal.PlainDate,
    to: Temporal.PlainDate,
  ): Promise<readonly SellerHealthSnapshot[]>;
}

export const SELLER_HEALTH_STORE = Symbol('SELLER_HEALTH_STORE');
