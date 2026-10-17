import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type { BusinessDetailsAnswer, ReviewSellerSource } from '../application/ports/review.ports';

/**
 * {@link ReviewSellerSource} on the `sellers` facade (certification design 8.5): the store names
 * of `sellerSummaries` for the queue and `reviewerBusinessDetails` for the review page, each
 * called with the caller's context unchanged. A refusal or a fault never throws: the queue shows
 * a row without a name, and the review page says why the business details are absent. The
 * business details are personal data and are returned, never logged.
 */
export class SellersReviewSource implements ReviewSellerSource {
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

  async businessDetails(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<BusinessDetailsAnswer> {
    try {
      const answer = await this.sellers.reviewerBusinessDetails(context, sellerId);
      if (answer.ok) {
        const { businessName, storeName, operatingAddress, registeredAddress } = answer.value;
        return {
          status: 'ok',
          details: { businessName, storeName, operatingAddress, registeredAddress },
        };
      }
      switch (answer.error.code) {
        case 'seller.details-not-found':
          return { status: 'not-found' };
        case 'access.denied':
          return { status: 'denied' };
        default:
          return { status: 'unavailable' };
      }
    } catch {
      return { status: 'unavailable' };
    }
  }
}
