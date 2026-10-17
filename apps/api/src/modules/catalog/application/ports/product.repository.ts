import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Product } from '../../domain/product';

/**
 * The store of products and their variant registry (catalog data design 3.1 to 3.3). Every
 * method runs in the open unit of the use case, through the Market-scoped client.
 */
export interface ProductRepository {
  /**
   * The next product code of the Market, formatted. One statement; its row lock is held to the
   * end of the unit, so two units never take the same value (a gap after a rollback is harmless).
   */
  nextProductCode(market: MarketContext): Promise<string>;

  /** Inserts a product built by `Product.create`, with its variants. */
  add(market: MarketContext, product: Product): Promise<void>;

  /** The product in this Market, or null: another Market's id is not found (AC 1). */
  findById(market: MarketContext, id: Id<'Product'>): Promise<Product | null>;

  /**
   * Writes a changed product and its variants under the version it was read at. Throws
   * `StaleAggregateError` when the row changed since (P 10).
   */
  save(market: MarketContext, product: Product): Promise<void>;

  /**
   * Takes the product row's lock in the open unit, conditional on the version the caller read
   * (catalog slice 11; Hassan M1 condition on slice 8): one `UPDATE` that sets the version to
   * itself. True when the row is still at that version; false when it moved (a publish committed
   * since the read, or is committing now: the statement waits for its lock, then sees the new
   * version). A tag write takes it before it judges its decisions, so a revision publication and
   * a tag write on the same product never interleave. Nothing else of the row changes.
   */
  lockAtVersion(market: MarketContext, id: Id<'Product'>, version: number): Promise<boolean>;
}

export const PRODUCT_REPOSITORY = Symbol('PRODUCT_REPOSITORY');
