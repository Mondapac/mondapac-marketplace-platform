import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * What the seller's catalogue says, for the campaigns and the previews. Every answer is null when
 * it is not known (the read failed, or catalog has no answer yet): callers then show "unknown"
 * and never guess. Bound to `catalog`'s facade, called with the seller's own context. Called
 * before any unit opens.
 */
export interface SellerCatalogue {
  /**
   * Which of these products the seller sells now (a listed Offer of the seller is on it). At most
   * as many ids as the Market allows a promotion to target; the adapter splits them.
   */
  sellsProducts(
    context: CallContext,
    sellerId: Id<'Seller'>,
    productIds: readonly Id<'Product'>[],
  ): Promise<ReadonlySet<Id<'Product'>> | null>;

  /** Whether the Offer is this seller's and the Variant is one of its sell units. */
  ownsSellUnit(
    context: CallContext,
    sellerId: Id<'Seller'>,
    offerId: Id<'Offer'>,
    variantId: Id<'Variant'>,
  ): Promise<boolean>;
}

export const SELLER_CATALOGUE = Symbol('PROMOTIONS_SELLER_CATALOGUE');
