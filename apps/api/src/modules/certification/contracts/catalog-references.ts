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
 * (`access.unavailable`), never "exists". `publishedProductRevisions` and `variantsOf` came with
 * slice 14, their first consumer (manufacturer coverage, M3).
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

  /**
   * Per requested product that is `published` in the Market, its current published revision id
   * (M3: coverage records the revision it was checked against). A product of another Market, an
   * unknown one and one that is not published are absent. At most
   * {@link MAX_CATALOG_REFERENCE_IDS} ids.
   */
  publishedProductRevisions(
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
  ): Promise<ReadonlyMap<Id<'Product'>, Id<'ProductRevision'>>>;

  /**
   * Per (product, product revision) asked, the variants that revision publishes: the variants a
   * coverage entry may be narrowed to (CERT-41). A pair whose revision is not that product's, or
   * of another Market, answers no variants. Batched (the design's `variantsOf(market, productId)`
   * per product), so the pair is read once and against the revision coverage records. At most
   * {@link MAX_CATALOG_REFERENCE_IDS} pairs.
   */
  variantsOf(
    market: MarketContext,
    revisions: readonly {
      readonly productId: Id<'Product'>;
      readonly productRevisionId: Id<'ProductRevision'>;
    }[],
  ): Promise<ReadonlyMap<Id<'Product'>, ReadonlySet<Id<'Variant'>>>>;
}

export const CATALOG_REFERENCES = Symbol('CATALOG_REFERENCES');
