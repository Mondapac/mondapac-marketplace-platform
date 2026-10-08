import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { SellerTaxProfile } from '../../domain/tax-registration';

/**
 * The store of seller tax profiles and their registration periods (sellers data design 3.7).
 * Every method runs in the open unit of the use case.
 */
export interface TaxProfileRepository {
  /**
   * The profile of this seller in the Market with all its periods, or null: a seller of another
   * Market is null, exactly like an unknown id (AC 1).
   */
  findBySellerId(market: MarketContext, sellerId: Id<'Seller'>): Promise<SellerTaxProfile | null>;

  /**
   * Writes the change the aggregate recorded: the root's version first (only where the stored
   * version is still `profile.persistedVersion`, optimistic, P 10), then the deleted periods, the
   * closed ones and the inserted ones, in that order, so the no-overlap constraint holds after
   * every statement. Answers false and writes nothing when another unit changed the profile
   * first. A period that would overlap another throws (the database repeats the aggregate's rule).
   */
  save(market: MarketContext, profile: SellerTaxProfile): Promise<boolean>;
}

export const TAX_PROFILE_REPOSITORY = Symbol('TAX_PROFILE_REPOSITORY');
