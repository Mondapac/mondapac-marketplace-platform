import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Product } from '../../domain/product';
import type { ProductRepository } from '../ports/product.repository';

/**
 * The seller's own live SELLER product, or null: another seller's product, a PLATFORM product, a
 * discarded or withdrawn one and an unknown id are all the same null, so the answer never tells
 * them apart. Call it inside an open unit.
 */
export async function ownedProduct(
  products: ProductRepository,
  market: MarketContext,
  sellerId: Id<'Seller'>,
  productId: Id<'Product'>,
): Promise<Product | null> {
  const product = await products.findById(market, productId);
  if (product === null) return null;
  const { state } = product;
  if (
    state.scope !== 'SELLER' ||
    state.ownerSellerId !== sellerId ||
    state.status === 'discarded' ||
    state.status === 'withdrawn'
  ) {
    return null;
  }
  return product;
}

/** What a seller sees of a photo: its id and size. The files are fetched by the read route. */
export interface ProductImageView {
  readonly imageId: string;
  readonly width: number;
  readonly height: number;
  readonly createdAt: string;
}
