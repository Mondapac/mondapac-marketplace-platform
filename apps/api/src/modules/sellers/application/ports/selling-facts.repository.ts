import type { Id, MarketContext } from '@mondapac/shared-kernel';

/**
 * What `sellers` holds about a seller with an approved revision, for the may-sell contract
 * (sellers design 7.2 row 2): clear columns only, no key unwrapped (data design 8, row
 * `sellingEligibility`).
 */
export interface ApprovedSellingFacts {
  /** The approved revision carries an identifier (its clear index is not NULL). */
  readonly hasIdentifier: boolean;
  /** The approved revision's operating zone, as stored. */
  readonly operatingTimezone: string;
  /** An `identifier-claim-conflict` admin flag is open for the seller (Hassan, slice 9). */
  readonly openClaimConflict: boolean;
}

/** The admin's product-type setting of a seller (data design 3.9). */
export type AllowedProductTypesSetting = 'all' | 'listed';

/**
 * The reads behind `sellingEligibility` and `allowedProductTypesOf` (sellers design 7.1, 7.2).
 * Each runs in the caller's read-only unit, on `sellers`' own rows.
 */
export interface SellingFactsRepository {
  /**
   * Per seller with an approved revision in the Market. A seller with none, of another Market or
   * unknown is absent. At most 100 ids; the caller bounds the list.
   */
  approvedSellingFacts(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, ApprovedSellingFacts>>;

  /** The setting row of the seller in the Market; null when there is none (a fault, D 2.1). */
  allowedProductTypes(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<AllowedProductTypesSetting | null>;
}

export const SELLING_FACTS_REPOSITORY = Symbol('SELLING_FACTS_REPOSITORY');
