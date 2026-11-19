import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type {
  SellerEligibilityReader,
  SellerEligibilityStatusReader,
} from '../application/ports/seller-eligibility.reader';

/**
 * {@link SellerEligibilityReader} on `sellers.sellingEligibility`. Any refusal, missing key or
 * thrown error is "not eligible"; no reason is kept (sellers design 7.2).
 */
export class SellersSellerEligibilityReader
  implements SellerEligibilityReader, SellerEligibilityStatusReader
{
  constructor(private readonly sellers: SellersFacade) {}

  async isEligible(context: CallContext, sellerId: Id<'Seller'>): Promise<boolean> {
    try {
      const answer = await this.sellers.sellingEligibility(context, [sellerId]);
      return answer.ok && answer.value.get(sellerId)?.eligible === true;
    } catch {
      return false;
    }
  }

  async status(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<'eligible' | 'not-eligible' | 'unavailable'> {
    try {
      const answer = await this.sellers.sellingEligibility(context, [sellerId]);
      if (!answer.ok) {
        // A read that failed, or a gate that could not decide, is "wait and retry"; only a
        // plain denial or refusal is "not eligible".
        const code: string = answer.error.code;
        return code === 'sellers.unavailable' || code === 'access.unavailable'
          ? 'unavailable'
          : 'not-eligible';
      }
      return answer.value.get(sellerId)?.eligible === true ? 'eligible' : 'not-eligible';
    } catch {
      return 'unavailable';
    }
  }
}
