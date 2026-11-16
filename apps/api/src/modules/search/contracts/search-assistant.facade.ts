import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';

/**
 * A product found for the buyer assistant: ids, text, the public store name and the price pricing
 * answers now (Money, never Cost), for the card only. Never a badge or stock. The price is null
 * when pricing cannot be read: the card then shows none, never a guess.
 */
export interface AssistantProduct {
  readonly offerId: Id<'Offer'>;
  readonly productId: Id<'Product'>;
  readonly sellerId: Id<'Seller'>;
  readonly name: string;
  readonly shortText: string | null;
  /** The public store name of the seller, or null when it cannot be read. */
  readonly sellerName: string | null;
  /** The lowest buyer price of the Offer now, or null. */
  readonly price: Money | null;
  /** The regular price while `price` is a special; otherwise null. */
  readonly regularPrice: Money | null;
  readonly taxInclusive: boolean | null;
  /** True when the Offer has Variants at different prices, so `price` is a "from" price. */
  readonly priceFrom: boolean;
}

/** A product on the specials shelf, with the prices pricing answered (Money, never Cost). */
export interface AssistantSpecial extends AssistantProduct {
  readonly price: Money;
  readonly regularPrice: Money;
  readonly taxInclusive: boolean;
}

/** One certification badge of an Offer as catalog answers it live; display only (R1). */
export interface AssistantBadge {
  readonly typeCode: string;
  readonly typeName: string;
  readonly sellerClaim: boolean;
}

/** One Offer of a product for the assistant. No stock figure. */
export interface AssistantOffer {
  readonly offerId: Id<'Offer'>;
  readonly sellerId: Id<'Seller'>;
  readonly sellerName: string | null;
  readonly price: Money;
  readonly taxInclusive: boolean;
  readonly priceFrom: boolean;
  readonly badges: readonly AssistantBadge[];
}

/** The product page's facts for the assistant. Seller-entered text: data, never instructions. */
export interface AssistantProductDetail {
  readonly productId: Id<'Product'>;
  readonly name: string;
  readonly shortDescription: string | null;
  readonly description: string | null;
  readonly brandName: string | null;
  /** Attribute name and its value as one text, in catalog's order. */
  readonly attributes: readonly { readonly name: string; readonly value: string }[];
  /** Cheapest Offer first. */
  readonly offers: readonly [AssistantOffer, ...AssistantOffer[]];
}

/** The query was refused (`validation.failed`) or could not be checked (`search.unavailable`). */
export type AssistantSearchFailure = { readonly code: 'validation.failed' | 'search.unavailable' };

/**
 * The READ tools `search` publishes for the buyer assistant (ADR-0019 decision 6, R3): each is a
 * facade method that passes the caller's `CallContext` unchanged to the storefront's own use case
 * (rule `anonymous`), so the assistant sees exactly what the buyer's own search would show.
 */
export interface SearchAssistantFacade {
  searchProducts(
    context: CallContext,
    query: {
      readonly text: string | null;
      readonly categoryId: string | null;
      readonly limit: number;
    },
  ): Promise<Result<readonly AssistantProduct[], AssistantSearchFailure>>;
  bestsellers(
    context: CallContext,
    query: { readonly categoryId: string | null; readonly limit: number },
  ): Promise<Result<readonly AssistantProduct[], AssistantSearchFailure>>;
  specials(
    context: CallContext,
    query: { readonly categoryId: string | null; readonly limit: number },
  ): Promise<Result<readonly AssistantSpecial[], AssistantSearchFailure>>;
  /** The product page read (`search.view-product-detail`); `not-found` when it is not sold now. */
  productDetail(
    context: CallContext,
    productId: string,
  ): Promise<
    Result<AssistantProductDetail, AssistantSearchFailure | { readonly code: 'not-found' }>
  >;
  /**
   * How many products the store with this public name and address has on sale. `null` means
   * unknown (not found by the store query, or a failed read), never zero: the card shows none.
   */
  storeProductCount(
    context: CallContext,
    store: { readonly slug: string; readonly name: string },
  ): Promise<number | null>;
}

export const SEARCH_ASSISTANT_FACADE = Symbol('SEARCH_ASSISTANT_FACADE');
