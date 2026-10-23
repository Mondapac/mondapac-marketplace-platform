import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type { SellerEligibility } from '../application/ports/seller-eligibility';

/** Sellers' facade takes at most 100 ids per call. */
const BATCH = 100;

/** {@link SellerEligibility} over sellers' `sellingEligibility`. Any refusal or failure is `null`. */
export class FacadeSellerEligibility implements SellerEligibility {
  constructor(private readonly sellers: SellersFacade) {}

  async eligible(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlySet<Id<'Seller'>> | null> {
    const distinct = [...new Set(sellerIds)];
    const yes = new Set<Id<'Seller'>>();
    try {
      for (let at = 0; at < distinct.length; at += BATCH) {
        const answer = await this.sellers.sellingEligibility(
          context,
          distinct.slice(at, at + BATCH),
        );
        if (!answer.ok) return null;
        for (const [sellerId, { eligible }] of answer.value) if (eligible) yes.add(sellerId);
      }
    } catch {
      return null;
    }
    return yes;
  }
}
