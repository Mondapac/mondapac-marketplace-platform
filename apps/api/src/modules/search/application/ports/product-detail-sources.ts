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
}

export const PRODUCT_DETAIL_SOURCES = Symbol('PRODUCT_DETAIL_SOURCES');
