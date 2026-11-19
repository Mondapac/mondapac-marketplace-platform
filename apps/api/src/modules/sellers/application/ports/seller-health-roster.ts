import type { Id, MarketContext } from '@mondapac/shared-kernel';

/** One seller the nightly run measures, with the zone its local days are cut in. */
export interface SellerHealthRosterEntry {
  readonly sellerId: Id<'Seller'>;
  /** The IANA zone of the seller's approved operating address (ADR-0005). */
  readonly zone: string;
}

/**
 * The sellers the nightly run measures: those with an approved business file (a seller that was
 * never approved sells nothing, so it has no health). A keyset page by seller id, ascending, so a
 * run can walk the whole Market in bounded batches. Runs in a read-only unit.
 */
export interface SellerHealthRoster {
  page(
    market: MarketContext,
    after: Id<'Seller'> | null,
    limit: number,
  ): Promise<readonly SellerHealthRosterEntry[]>;

  /**
   * One seller, or `null` when it is not in this Market or has no approved business file (so no
   * zone to cut its days in). Runs in a read-only unit.
   */
  one(market: MarketContext, sellerId: Id<'Seller'>): Promise<SellerHealthRosterEntry | null>;
}

export const SELLER_HEALTH_ROSTER = Symbol('SELLER_HEALTH_ROSTER');
