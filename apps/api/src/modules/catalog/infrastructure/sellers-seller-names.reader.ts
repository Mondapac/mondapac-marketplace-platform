import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type { SellerNamesReader } from '../application/ports/seller-names.reader';

/**
 * {@link SellerNamesReader} on `sellers.sellerSummaries` (catalog design 9.6). A refusal or a
 * thrown error is an empty map: the review queue is still usable without store names.
 */
export class SellersSellerNamesReader implements SellerNamesReader {
  constructor(private readonly sellers: SellersFacade) {}

  async storeNames(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, string>> {
    const names = new Map<Id<'Seller'>, string>();
    const requested = [...new Set(sellerIds)].slice(0, 100);
    if (requested.length === 0) return names;
    try {
      const answer = await this.sellers.sellerSummaries(context, requested);
      if (!answer.ok) return names;
      for (const summary of answer.value) {
        if (typeof summary.storeName === 'string') names.set(summary.sellerId, summary.storeName);
      }
    } catch {
      return new Map();
    }
    return names;
  }
}
