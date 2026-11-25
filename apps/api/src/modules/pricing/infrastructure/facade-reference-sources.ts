import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type { SettingsFacade } from '../../settings';
import type {
  ReferenceBusinesses,
  ReferenceSettings,
  ReferenceSettingsSource,
} from '../application/ports/first-price-reference';

/**
 * {@link ReferenceSettingsSource} on `SettingsFacade.offerReviewPolicy` (ADR-0051). The facade
 * never fails: a refused or failed read is its safe policy (20 businesses, a 5% band), so fewer
 * Variants have a reference and more Offers are reviewed after publication.
 */
export class FacadeReferenceSettings implements ReferenceSettingsSource {
  constructor(private readonly facade: SettingsFacade) {}

  async settings(context: CallContext): Promise<ReferenceSettings> {
    const policy = await this.facade.offerReviewPolicy(context);
    return { referenceSellers: policy.referenceSellers, priceBandPercent: policy.priceBandPercent };
  }
}

/**
 * {@link ReferenceBusinesses} on `SellersFacade.sellingEligibility`: a seller counts as a business
 * only when `sellers` says it may sell now. That answer already excludes a seller with an open
 * `identifier-claim-conflict` flag, and an approved seller holds the only claim on its business
 * identifier (ABN) in the Market, so two eligible sellers are two businesses. Any refusal throws.
 */
export class SellersReferenceBusinesses implements ReferenceBusinesses {
  constructor(private readonly sellers: SellersFacade) {}

  async eligibleSellers(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlySet<Id<'Seller'>>> {
    if (sellerIds.length === 0) return new Set();
    const answer = await this.sellers.sellingEligibility(context, sellerIds);
    if (!answer.ok) throw new Error(`sellers.sellingEligibility: ${answer.error.code}`);
    const eligible = new Set<Id<'Seller'>>();
    for (const [sellerId, value] of answer.value) {
      if (value.eligible) eligible.add(sellerId);
    }
    return eligible;
  }
}
