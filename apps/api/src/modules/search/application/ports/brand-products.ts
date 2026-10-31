import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * Which products are the live products of a brand in the request's Market (catalog's rule: published,
 * with an Offer on sale). An unknown, draft or archived brand is an empty list, byte-identical.
 * `truncated` is true when the brand has more live products than the list holds. `null` when the
 * read was refused or failed: the caller fails closed (`search.unavailable`), never a list that
 * ignores the brand.
 */
export interface BrandProducts {
  productIdsOf(
    context: CallContext,
    slug: string,
  ): Promise<{ readonly productIds: readonly Id<'Product'>[]; readonly truncated: boolean } | null>;
}

export const BRAND_PRODUCTS = Symbol('BRAND_PRODUCTS');
