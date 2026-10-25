import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type { StoreDirectory } from '../application/ports/store-directory';

/** {@link StoreDirectory} on the sellers facade; any refusal or fault is `unavailable`. */
export class SellersStoreDirectory implements StoreDirectory {
  constructor(private readonly sellers: SellersFacade) {}

  async sellerOf(context: CallContext, slug: string): Promise<Id<'Seller'> | null | 'unavailable'> {
    const result = await this.sellers.publishedStoreSellerId(context, slug);
    return result.ok ? result.value : 'unavailable';
  }
}
