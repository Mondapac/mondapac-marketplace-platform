import type { CallContext, Id, Money, Temporal } from '@mondapac/shared-kernel';

/** One Variant of the published product, in position order. */
export interface DetailVariant {
  readonly variantId: Id<'Variant'>;
  readonly label: string | null;
}

/** The published content of a product, as catalog tells it; seller-entered text: escape it. */
export interface DetailProduct {
  readonly name: string;
  readonly shortDescription: string | null;
  readonly description: string | null;
  readonly categoryIds: readonly Id<'Category'>[];
  readonly variants: readonly DetailVariant[];
  /** The product's active brand (page slug and name), or null. */
  readonly brand: { readonly slug: string; readonly name: string } | null;
}

/** One (Offer, Variant) a price or a stock state is asked for. */
export interface DetailKey {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
}

/** The map key of a {@link DetailKey}. */
export function detailKeyOf(key: DetailKey): string {
  return `${key.offerId}/${key.variantId}`;
}

/** The price a buyer pays now; `special` is set only while the price is a special. */
export interface DetailPrice {
  readonly price: Money;
  readonly taxInclusive: boolean;
  readonly special: { readonly endsAt: Temporal.Instant } | null;
}

/** The public stock state: never the exact count. `onlyLeft` is set for `low`. */
export interface DetailStock {
  readonly status: 'in-stock' | 'low' | 'out';
  readonly onlyLeft: number | null;
}

/** What a buyer sees of a seller. `minimumOrder` is absent when it cannot be told, null for none. */
export interface DetailSeller {
  readonly storeName: string | null;
  readonly minimumOrder?: Money | null;
}

/**
 * One certification badge of an Offer, as catalog's `offerBadges` answers it (built from a live
 * `evaluateClaims` decision there; search adds nothing and decides nothing). Display only.
 */
export interface DetailBadge {
  readonly typeCode: string;
  readonly typeName: string;
  readonly basis: 'SELLER' | 'MANUFACTURER';
  readonly sellerClaim: boolean;
  readonly issuerName: string | null;
  /** An ISO calendar date (`YYYY-MM-DD`), or null. */
  readonly validUntilLocalDate: string | null;
  readonly verifiedWithIssuer: boolean;
}

/**
 * Where the product page gets its facts: catalog's published product, pricing's buyer prices,
 * inventory's public stock state and sellers' public summaries. Each is called with the request's
 * context unchanged. A source that refused or failed is `null`: the caller fails closed. A product
 * that is not published is `{ product: null }`, not a failure.
 */
export interface ProductDetailSources {
  product(
    context: CallContext,
    productId: Id<'Product'>,
    locale: string,
  ): Promise<{ readonly product: DetailProduct | null } | null>;
  /** Keyed by {@link detailKeyOf}; a key without a price in force is absent. */
  prices(
    context: CallContext,
    keys: readonly DetailKey[],
  ): Promise<ReadonlyMap<string, DetailPrice> | null>;
  /** Keyed by {@link detailKeyOf}; a key inventory does not answer is absent. */
  availability(
    context: CallContext,
    keys: readonly DetailKey[],
  ): Promise<ReadonlyMap<string, DetailStock> | null>;
  sellers(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, DetailSeller> | null>;
  /**
   * The badges of the Offers (at most 20), asked live in this request. An Offer with none is
   * absent. A failure is `null`: the page then shows no badge (badges fail closed, the page does
   * not).
   */
  badges(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, readonly DetailBadge[]> | null>;
}

export const PRODUCT_DETAIL_SOURCES = Symbol('PRODUCT_DETAIL_SOURCES');
