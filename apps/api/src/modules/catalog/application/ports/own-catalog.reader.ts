import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Offer } from '../../domain/offer';
import type { Product } from '../../domain/product';
import type { WorkingCopy } from '../../domain/working-copy';

/** One page request: the last id of the previous page, and at most `limit` rows. */
export interface ListPage<K extends string> {
  readonly afterId: Id<K> | null;
  readonly limit: number;
}

export interface ProductLabel {
  readonly productId: Id<'Product'>;
  readonly productCode: string;
  readonly typeCode: string;
  readonly name: string | null;
}

/**
 * The seller's own catalogue lists (catalog design 8.2, 9.2a): products and Offers of one seller,
 * newest first by id (UUID v7). The owner is in every statement, so another seller's row is never
 * read. Runs in the open (read-only) unit of the use case, through the Market-scoped client.
 */
export interface OwnCatalogReader {
  /** The seller's SELLER products except the discarded and withdrawn ones. */
  listProducts(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    page: ListPage<'Product'>,
  ): Promise<readonly Product[]>;

  /** The seller's Offers that are not deleted. */
  listOffers(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    page: ListPage<'Offer'>,
  ): Promise<readonly Offer[]>;

  /**
   * The code, type and published name (in `locale`, else null) of the given products of any
   * scope: the label an Offer row shows for its product. At most 100 ids; unknown ids are absent.
   */
  productLabels(
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
    locale: string,
  ): Promise<readonly ProductLabel[]>;

  /** The working copies of the given products (at most 100 ids), in no order. */
  findWorkingCopies(
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
  ): Promise<readonly WorkingCopy[]>;
}

export const OWN_CATALOG_READER = Symbol('OWN_CATALOG_READER');
