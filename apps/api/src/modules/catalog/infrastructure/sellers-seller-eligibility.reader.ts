import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type { SellerEligibilityReader } from '../application/ports/seller-eligibility.reader';

/**
 * {@link SellerEligibilityReader} on `sellers.sellingEligibility`. Any refusal, missing key or
 * thrown error is "not eligible"; no reason is kept (sellers design 7.2).
 */
export class SellersSellerEligibilityReader implements SellerEligibilityReader {
  constructor(private readonly sellers: SellersFacade) {}

  async isEligible(context: CallContext, sellerId: Id<'Seller'>): Promise<boolean> {
    try {
      const answer = await this.sellers.sellingEligibility(context, [sellerId]);
      return answer.ok && answer.value.get(sellerId)?.eligible === true;
    } catch {
      return false;
    }
  }
}
