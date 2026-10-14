import type { Id, MarketContext, Money, Temporal } from '@mondapac/shared-kernel';

/** A seller's flat fee as stored. */
export interface FlatFeeRecord {
  readonly sellerId: Id<'Seller'>;
  readonly fee: Money;
  readonly updatedAt: Temporal.Instant;
}

/**
 * The flat fees of one Market (`shipping.seller_flat_fees`). Every method runs inside the
 * caller's unit of work and is scoped by the Market.
 */
export interface FlatFeeRepository {
  find(market: MarketContext, sellerId: Id<'Seller'>): Promise<FlatFeeRecord | null>;

  /** The fees of the listed sellers that have one. */
  findMany(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<readonly FlatFeeRecord[]>;

  /** Stores the fee, replacing an earlier one. */
  save(
    market: MarketContext,
    record: FlatFeeRecord & { readonly updatedBy: Id<'Account'> },
  ): Promise<void>;
}

export const FLAT_FEE_REPOSITORY = Symbol('FLAT_FEE_REPOSITORY');
