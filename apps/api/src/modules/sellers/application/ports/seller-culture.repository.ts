import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { SellerCultureState } from '../../domain/seller-culture';

/**
 * The store of seller culture memberships (ADR-0047 decision 3), on `sellers.seller_cultures`.
 * Writes run in the caller's read-write unit. Every write is guarded by the state it expects, so two
 * units that race on one membership cannot both win: the loser's method answers `false`.
 */
export interface SellerCultureRepository {
  /**
   * The seller's memberships, by culture code. At most 200 are returned (the most a Market has
   * cultures); the repository logs a warning when it returns exactly 200.
   */
  forSeller(market: MarketContext, sellerId: Id<'Seller'>): Promise<readonly SellerCultureState[]>;

  /** The seller's memberships among these cultures. */
  among(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    cultureIds: readonly Id<'Culture'>[],
  ): Promise<ReadonlyMap<Id<'Culture'>, SellerCultureState>>;

  /**
   * Up to `limit` sellers of the Market that have a file and no membership row of the Market at
   * all, by seller id ascending and only those after `after` (a cursor, so a seller that fails is
   * passed over and not asked again first on every batch). The one-time attach of sellers that
   * predate ADR-0048.
   */
  sellerIdsWithoutCultures(
    market: MarketContext,
    limit: number,
    after?: Id<'Seller'>,
  ): Promise<readonly Id<'Seller'>[]>;

  /** Whether any seller is approved in the culture (catalog asks before it changes the culture's required type). */
  hasApproved(market: MarketContext, cultureId: Id<'Culture'>): Promise<boolean>;

  /** Inserts a first request; false when the seller already has a row for the culture. */
  insert(market: MarketContext, state: SellerCultureState): Promise<boolean>;

  /**
   * Writes the next state of a row that was read at `expectedVersion` with `expectedStatus`; false
   * when it changed since (another request or decision won).
   */
  transition(
    market: MarketContext,
    state: SellerCultureState,
    expected: { readonly version: number; readonly status: 'requested' | 'rejected' | 'approved' },
  ): Promise<boolean>;
}

export const SELLER_CULTURE_REPOSITORY = Symbol('SELLER_CULTURE_REPOSITORY');
