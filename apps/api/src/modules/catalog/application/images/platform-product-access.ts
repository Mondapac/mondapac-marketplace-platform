import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import type { Product } from '../../domain/product';
import type { ProductRepository } from '../ports/product.repository';

/** The admin whose request this is, or null for any other caller. */
export function adminAccountOf(context: CallContext): Id<'Account'> | null {
  const { actor } = context;
  return actor.kind === 'authenticated' && actor.population === 'admin' ? actor.accountId : null;
}

/**
 * A PLATFORM product an admin may add pictures to: one that exists, is PLATFORM scoped and has not
 * been discarded. A SELLER product, a missing one and a discarded one are all null, so the caller
 * answers one `product.not-found` for the three (the same rule as `platform-product.read`).
 */
export async function platformProduct(
  products: ProductRepository,
  market: MarketContext,
  productId: Id<'Product'>,
): Promise<Product | null> {
  const product = await products.findById(market, productId);
  if (product === null) return null;
  const { state } = product;
  return state.scope === 'PLATFORM' && state.status !== 'discarded' ? product : null;
}
