import type { Id, MarketContext } from '@mondapac/shared-kernel';

/** At most this many ids per call; a larger call is refused whole (rejects). */
export const MAX_CATALOG_REFERENCE_IDS = 500;

/**
 * What `certification` reads of `catalog` (certification design 8.2, request C-3; ADR-0028 d9):
 * the existence of platform categories named by policy rows (3.7). Declared here, implemented by
 * `catalog/infrastructure` and bound by `catalog`'s global references module, so `certification`
 * imports nothing of `catalog`. A named exception of 7.4: no actor, a `MarketContext` only (the
 * answers are not personal and are asked under admin actors only). Each call opens its own
 * read-only unit; a failure rejects, and the caller refuses its own use case
 * (`access.unavailable`), never "exists". `publishedProductRevisions` and `variantsOf` join with
 * slice 14, their first consumer (manufacturer coverage).
 */
export interface CatalogReferences {
  /**
   * The subset of `categoryIds` that are active platform categories of the Market. A merged or
   * archived category, an id of another Market and an unknown id are all absent. At most
   * {@link MAX_CATALOG_REFERENCE_IDS} ids.
   */
  platformCategoriesExist(
    market: MarketContext,
    categoryIds: readonly Id<'Category'>[],
  ): Promise<ReadonlySet<Id<'Category'>>>;
}

export const CATALOG_REFERENCES = Symbol('CATALOG_REFERENCES');
