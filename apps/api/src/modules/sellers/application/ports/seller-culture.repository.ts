import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { SellerCultureState } from '../../domain/seller-culture';

/**
 * The store of seller culture memberships (ADR-0047 decision 3), on `sellers.seller_cultures`.
 * Writes run in the caller's read-write unit. Every write is guarded by the state it expects, so two
 * units that race on one membership cannot both win: the loser's method answers `false`.
 */
export interface SellerCultureRepository {
  /** The seller's memberships, by culture code. */
  forSeller(market: MarketContext, sellerId: Id<'Seller'>): Promise<readonly SellerCultureState[]>;

  /** The seller's memberships among these cultures. */
  among(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    cultureIds: readonly Id<'Culture'>[],
  ): Promise<ReadonlyMap<Id<'Culture'>, SellerCultureState>>;

  /**
   * Up to `limit` sellers of the Market that have a file and no membership row at all, oldest file
   * first (the one-time attach of sellers that predate ADR-0048).
   */
  sellerIdsWithoutCultures(market: MarketContext, limit: number): Promise<readonly Id<'Seller'>[]>;

  /** Inserts a first request; false when the seller already has a row for the culture. */
  insert(market: MarketContext, state: SellerCultureState): Promise<boolean>;

  /**
   * Writes the next state of a row that was read at `expectedVersion` with `expectedStatus`; false
   * when it changed since (another request or decision won).
   */
  transition(
    market: MarketContext,
    state: SellerCultureState,
    expected: { readonly version: number; readonly status: 'requested' | 'rejected' },
  ): Promise<boolean>;
}

export const SELLER_CULTURE_REPOSITORY = Symbol('SELLER_CULTURE_REPOSITORY');
