import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { StoredRevision } from '../../domain/stored-revision';

/**
 * The store of product revisions (catalog data design 3.7 to 3.10). Every method runs in the open
 * unit of the caller, through the Market-scoped client. Revisions are insert-only: there is no
 * update and no delete.
 */
export interface ProductRevisionRepository {
  /** The number the next revision of the product takes: one more than the highest, or 1. */
  nextRevisionNo(market: MarketContext, productId: Id<'Product'>): Promise<number>;

  /**
   * Writes the revision row with its texts, categories and variants. A revision that carries
   * images is refused until the image slice (13) exists. The database refuses a variant of
   * another product or a retired one, a category of another Market, a repeated option key.
   */
  add(market: MarketContext, revision: StoredRevision): Promise<void>;

  /** The revision of this product in this Market, or null (also for another product's id). */
  find(
    market: MarketContext,
    productId: Id<'Product'>,
    revisionId: Id<'ProductRevision'>,
  ): Promise<StoredRevision | null>;
}

export const PRODUCT_REVISION_REPOSITORY = Symbol('PRODUCT_REVISION_REPOSITORY');
