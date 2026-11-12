import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Product } from '../../domain/product';
import type { ProductRepository } from '../ports/product.repository';

/**
 * A live PLATFORM product whose photos an admin may change, or null: a SELLER product, a
 * discarded, withdrawn or retired one and an unknown id are all the same null, so the answer
 * never tells them apart. Call it inside an open unit.
 */
export async function editablePlatformProduct(
  products: ProductRepository,
  market: MarketContext,
  productId: Id<'Product'>,
): Promise<Product | null> {
  const product = await products.findById(market, productId);
  if (product === null) return null;
  const { state } = product;
  if (
    state.scope !== 'PLATFORM' ||
    (state.status !== 'draft' && state.status !== 'unpublished' && state.status !== 'published')
  ) {
    return null;
  }
  return product;
}
