import type { Id, MarketContext } from '@mondapac/shared-kernel';

/**
 * Sets `products.brand_id` from the `brand` attribute of a revision that was just published (catalog
 * brand package; the attribute stays readable during the transition). Runs in the publishing unit,
 * after the product row was saved.
 *
 * The value is resolved to an ACTIVE brand: by exact name, by slug, by name without regard to case
 * (when exactly one brand has it), then by alias. A value that names no active brand, or none at
 * all, clears the column: a product never keeps a brand its published text no longer names.
 */
export interface BrandAssigner {
  assignFromPublished(
    market: MarketContext,
    productId: Id<'Product'>,
    brandValue: string | null,
  ): Promise<void>;
}

export const BRAND_ASSIGNER = Symbol('BRAND_ASSIGNER');
