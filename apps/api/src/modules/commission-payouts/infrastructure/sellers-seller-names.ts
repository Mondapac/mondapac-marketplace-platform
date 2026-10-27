import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type { SellerNames } from '../application/ports/seller-names';

/** {@link SellerNames} on the sellers facade: the public store name of the approved revision. */
export class SellersSellerNames implements SellerNames {
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
}
