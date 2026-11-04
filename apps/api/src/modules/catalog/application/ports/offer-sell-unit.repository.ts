import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { SellUnitState } from '../../domain/offer-sell-unit';

/** Why a write was refused: the variant SKU is already a SKU of the seller (a unit or an Offer). */
export type OfferSellUnitRefusal = 'offer.sku-taken';

/** A written row: its id and version are the aggregate id and version of its events. */
export interface StoredSellUnit {
  readonly variantId: Id<'Variant'>;
  readonly rowId: Id;
  readonly version: number;
}

/**
 * The store of the per (Offer, Variant) sell-unit rows (`catalog.offer_sell_units`; variants V5).
 * The rows are sparse: a variant with no row sells and has no variant SKU. Every statement takes
 * the caller's Market. No row is ever deleted.
 */
export interface OfferSellUnitRepository {
  /**
   * The non-retired variants of the product in creation order, each with its stored state or the
   * default (selling, no SKU); `variantNo` is the number within the product.
   */
  unitsOf(
    market: MarketContext,
    offerId: Id<'Offer'>,
    productId: Id<'Product'>,
  ): Promise<readonly (SellUnitState & { readonly variantNo: number })[]>;

  /**
   * Writes the given states (insert, or update of an existing row). The SKU uniques decide a race:
   * a violation is answered as `offer.sku-taken` and the caller ends its unit with an error so
   * nothing of it commits.
   */
  save(
    market: MarketContext,
    offer: { readonly id: Id<'Offer'>; readonly sellerId: Id<'Seller'> },
    states: readonly SellUnitState[],
    now: Temporal.Instant,
  ): Promise<
    | { readonly refusal: OfferSellUnitRefusal }
    | { readonly refusal: null; readonly stored: readonly StoredSellUnit[] }
  >;
}

export const OFFER_SELL_UNIT_REPOSITORY = Symbol('OFFER_SELL_UNIT_REPOSITORY');
