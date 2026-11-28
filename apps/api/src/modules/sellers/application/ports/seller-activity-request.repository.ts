import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { ActivityAssignment } from '../../domain/seller-business-activities';

/** What a seller asked for: the set and when. It is a request, never what the seller carries. */
export interface StoredActivityRequest extends ActivityAssignment {
  readonly requestedAt: Temporal.Instant;
}

/**
 * The store of a seller's own request for business activities (BUG-012 step 2), on `sellers`' own
 * table `seller_activity_requests`: one row per seller. Writes run inside the caller's read-write
 * unit; every method is scoped by the Market.
 */
export interface SellerActivityRequestRepository {
  /** The seller's request, or null when none was saved. */
  find(market: MarketContext, sellerId: Id<'Seller'>): Promise<StoredActivityRequest | null>;

  /** Inserts or replaces the seller's request. */
  save(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    next: ActivityAssignment & { readonly by: Id<'Account'>; readonly at: Temporal.Instant },
  ): Promise<void>;
}

export const SELLER_ACTIVITY_REQUEST_REPOSITORY = Symbol('SELLER_ACTIVITY_REQUEST_REPOSITORY');
