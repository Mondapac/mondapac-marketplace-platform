import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type {
  SellerOfferReviewFlags,
  SellerOfferReviewFlagsReader,
} from '../application/ports/seller-offer-review-flags.reader';

/**
 * {@link SellerOfferReviewFlagsReader} on `sellers.offerReviewFlagsOf`. Only an `ok` answer is
 * read; a refusal, an unknown seller, an error or a throw is null (the caller fails closed).
 */
export class SellersOfferReviewFlagsReader implements SellerOfferReviewFlagsReader {
  constructor(private readonly sellers: SellersFacade) {}

  async flagsOf(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<SellerOfferReviewFlags | null> {
    try {
      const answer = await this.sellers.offerReviewFlagsOf(context, sellerId);
      if (!answer.ok) return null;
      const { trustedFromStart, fullReview, reviewStop } = answer.value;
      return {
        trustedFromStart: { on: trustedFromStart.on === true, at: trustedFromStart.at },
        fullReview: { on: fullReview.on === true, at: fullReview.at },
        reviewStop: { on: reviewStop.on === true, at: reviewStop.at },
      };
    } catch {
      return null;
    }
  }
}
