// Pure helpers of the product page's Variants. Kept apart from product-detail.ts so the client
// part of the page can import them without pulling in the server-only API reads.

/**
 * The Variant the page opens on: the first one in stock in the owner's order, or the first when
 * none is in stock.
 */
export function defaultVariantOf<V extends { readonly inStock: boolean }>(
  variants: readonly [V, ...V[]],
): V {
  return variants.find((variant) => variant.inStock) ?? variants[0];
}
