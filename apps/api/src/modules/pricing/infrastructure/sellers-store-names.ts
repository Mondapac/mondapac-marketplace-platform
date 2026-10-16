import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type { SellerStoreNames } from '../application/ports/held-labels';

/**
 * {@link SellerStoreNames} over sellers' facade `sellerSummaries`: only the public `storeName`
 * of the approved revision is read from the answer. The caller's `CallContext` goes through
 * unchanged. Any refusal is thrown; the caller shows no store name.
 */
export class SellersStoreNames implements SellerStoreNames {
  constructor(private readonly sellers: SellersFacade) {}

  async namesOf(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, string>> {
    const answer = await this.sellers.sellerSummaries(context, sellerIds);
    if (!answer.ok) throw new Error(`sellers.sellerSummaries: ${answer.error.code}`);
    const requested = new Set(sellerIds);
    const names = new Map<Id<'Seller'>, string>();
    for (const summary of answer.value) {
      if (requested.has(summary.sellerId) && typeof summary.storeName === 'string') {
        names.set(summary.sellerId, summary.storeName);
      }
    }
    return names;
  }
}
