import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';

/** A product found for the buyer assistant: ids and text only, never a badge, price or stock. */
export interface AssistantProduct {
  readonly offerId: Id<'Offer'>;
  readonly productId: Id<'Product'>;
  readonly sellerId: Id<'Seller'>;
  readonly name: string;
  readonly shortText: string | null;
}

/** A product on the specials shelf, with the prices pricing answered (Money, never Cost). */
export interface AssistantSpecial extends AssistantProduct {
  readonly price: Money;
  readonly regularPrice: Money;
  readonly taxInclusive: boolean;
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
    query: { readonly text: string | null; readonly categoryId: string | null; readonly limit: number },
  ): Promise<Result<readonly AssistantProduct[], AssistantSearchFailure>>;
  bestsellers(
    context: CallContext,
    query: { readonly categoryId: string | null; readonly limit: number },
  ): Promise<Result<readonly AssistantProduct[], AssistantSearchFailure>>;
  specials(
    context: CallContext,
    query: { readonly categoryId: string | null; readonly limit: number },
  ): Promise<Result<readonly AssistantSpecial[], AssistantSearchFailure>>;
}

export const SEARCH_ASSISTANT_FACADE = Symbol('SEARCH_ASSISTANT_FACADE');
