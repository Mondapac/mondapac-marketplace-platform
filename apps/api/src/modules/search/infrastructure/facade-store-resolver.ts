import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type { StoreResolver } from '../application/ports/store-resolver';

/**
 * {@link StoreResolver} over sellers' `publishedStoreSellerId` (the published-store rules of the
 * public store page), with the request's context unchanged. Any refusal or failure is `null`.
 */
export class FacadeStoreResolver implements StoreResolver {
  constructor(private readonly sellers: SellersFacade) {}

  async sellerIdOf(
    context: CallContext,
    slug: string,
  ): Promise<{ readonly sellerId: Id<'Seller'> | null } | null> {
    try {
      const result = await this.sellers.publishedStoreSellerId(context, slug);
      return result.ok ? { sellerId: result.value } : null;
    } catch {
      return null;
    }
  }
}
