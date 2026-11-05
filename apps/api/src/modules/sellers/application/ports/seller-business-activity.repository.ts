import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { StoredActivityAssignment } from '../../domain/seller-business-activities';

/** The last recorded change of a seller's activities: who, when and why. */
export interface ActivityChangeRecord {
  readonly changedBy: Id<'Account'>;
  readonly changedAt: Temporal.Instant;
  readonly reason: string;
}

/**
 * The store of the activities a seller carries and their change log (ADR-0040 decision 4), on
 * `sellers`' own tables. Writes run inside the caller's read-write unit; every method is scoped
 * by the Market.
 */
export interface SellerBusinessActivityRepository {
  /**
   * Locks the seller's setting row (raising its version holds the row lock until the unit ends, so
   * two replacements of one seller run one after the other); false when the seller has no file in
   * the Market.
   */
  lock(market: MarketContext, sellerId: Id<'Seller'>): Promise<boolean>;

  /** What each requested seller carries; a seller with none is absent. */
  find(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, StoredActivityAssignment>>;

  /** Replaces the seller's whole assignment (delete, then insert). */
  replace(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    next: {
      readonly mainActivityId: Id<'BusinessActivity'>;
      readonly extraActivityIds: readonly Id<'BusinessActivity'>[];
      readonly by: Id<'Account'>;
      readonly at: Temporal.Instant;
    },
  ): Promise<void>;

  /** Appends one row to the change log. */
  appendChange(
    market: MarketContext,
    entry: {
      readonly id: Id<'SellerActivityChange'>;
      readonly sellerId: Id<'Seller'>;
      readonly by: Id<'Account'>;
      readonly at: Temporal.Instant;
      readonly reason: string;
      readonly before: StoredActivityAssignment;
      readonly after: {
        readonly mainActivityId: Id<'BusinessActivity'>;
        readonly extraActivityIds: readonly Id<'BusinessActivity'>[];
      };
    },
  ): Promise<void>;

  /** The latest change of the seller, or null when none was made. */
  lastChange(market: MarketContext, sellerId: Id<'Seller'>): Promise<ActivityChangeRecord | null>;
}

export const SELLER_BUSINESS_ACTIVITY_REPOSITORY = Symbol('SELLER_BUSINESS_ACTIVITY_REPOSITORY');
