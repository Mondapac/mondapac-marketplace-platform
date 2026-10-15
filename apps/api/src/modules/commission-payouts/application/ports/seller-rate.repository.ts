import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** A seller's own commission rate as stored. */
export interface SellerRateRecord {
  readonly sellerId: Id<'Seller'>;
  readonly rateBps: number;
  readonly updatedAt: Temporal.Instant;
}

/**
 * The sellers' own rates of one Market (`commission_payouts.seller_commission_rates`). A seller
 * without a row is on the Market rate. Every method runs inside the caller's unit of work and is
 * scoped by the Market.
 */
export interface SellerRateRepository {
  find(market: MarketContext, sellerId: Id<'Seller'>): Promise<SellerRateRecord | null>;

  /**
   * Like `find`, and takes the row's write lock for the rest of the unit when it exists, so two
   * admin edits serialise and each audits the value it really replaced. (The guarded client sends
   * no raw SQL, so the lock is a no-change update.)
   */
  findForUpdate(market: MarketContext, sellerId: Id<'Seller'>): Promise<SellerRateRecord | null>;

  findMany(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<readonly SellerRateRecord[]>;

  /** Stores the rate, replacing an earlier one. */
  save(
    market: MarketContext,
    record: SellerRateRecord & { readonly updatedBy: Id<'Account'> },
  ): Promise<void>;

  /** Removes the seller's own rate; false when there was none. */
  remove(market: MarketContext, sellerId: Id<'Seller'>): Promise<boolean>;
}

export const SELLER_RATE_REPOSITORY = Symbol('SELLER_RATE_REPOSITORY');
