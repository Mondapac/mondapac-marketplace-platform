import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type { StoreNameSearch } from '../application/ports/store-name-search';

/** The longest text `sellers.searchStoreNames` accepts (after trimming). */
const STORE_SEARCH_MAX_LENGTH = 80;

/**
 * {@link StoreNameSearch} on `sellers.searchStoreNames`. A text longer than that method accepts
 * matches no store here (the product code and name still match); a refusal or a failed read
 * throws, so the review queue fails closed.
 */
export class SellersStoreNameSearch implements StoreNameSearch {
  constructor(private readonly sellers: SellersFacade) {}

  async sellersMatching(
    context: CallContext,
    text: string,
  ): Promise<{ readonly sellerIds: readonly Id<'Seller'>[]; readonly capped: boolean }> {
    if ([...text.trim()].length > STORE_SEARCH_MAX_LENGTH) return { sellerIds: [], capped: false };
    const answer = await this.sellers.searchStoreNames(context, text);
    if (!answer.ok) throw new Error(`sellers.searchStoreNames: ${answer.error.code}`);
    return answer.value;
  }
}
