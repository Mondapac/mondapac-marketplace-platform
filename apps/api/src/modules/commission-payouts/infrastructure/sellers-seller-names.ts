import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type { SellerNames } from '../application/ports/seller-names';
import type { StoreNameSearch } from '../application/ports/store-name-search';

/**
 * {@link SellerNames} and {@link StoreNameSearch} on the sellers facade: the public store name of
 * the approved revision, and the sellers whose name matches a list's search.
 */
export class SellersSellerNames implements SellerNames, StoreNameSearch {
  constructor(private readonly sellers: SellersFacade) {}

  async storeNames(context: CallContext, sellerIds: readonly Id<'Seller'>[]) {
    const names = new Map<Id<'Seller'>, string | null>();
    for (let i = 0; i < sellerIds.length; i += 100) {
      const result = await this.sellers.sellerSummaries(context, sellerIds.slice(i, i + 100));
      if (!result.ok) return 'unavailable' as const;
      for (const summary of result.value) names.set(summary.sellerId, summary.storeName);
    }
    return names;
  }

  async storesMatching(context: CallContext, term: string) {
    const answer = await this.sellers.searchStoreNames(context, term);
    // The term is never part of the error.
    if (!answer.ok) throw new Error(`sellers.searchStoreNames: ${answer.error.code}`);
    return answer.value;
  }
}
