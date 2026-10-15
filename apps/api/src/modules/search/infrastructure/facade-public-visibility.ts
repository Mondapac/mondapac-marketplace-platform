import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { CatalogFacade } from '../../catalog';
import type { SellersFacade } from '../../sellers';
import type { PublicVisibility } from '../application/ports/public-visibility';

/**
 * {@link PublicVisibility} over catalog's `offerSellUnits` (status published and listed) and
 * sellers' `sellingEligibility` (the may-sell contract). Both are advisory reads for a request
 * actor. Sellers has no separate "show publicly" read yet, so a seller who may sell is shown.
 * Any refusal or failure is `null`: the caller fails closed.
 */
export class FacadePublicVisibility implements PublicVisibility {
  constructor(
    private readonly catalog: CatalogFacade,
    private readonly sellers: SellersFacade,
  ) {}

  async visible(
    context: CallContext,
    offers: readonly { readonly offerId: Id<'Offer'>; readonly sellerId: Id<'Seller'> }[],
  ): Promise<ReadonlySet<Id<'Offer'>> | null> {
    if (offers.length === 0) return new Set();
    try {
      const [units, eligibility] = await Promise.all([
        this.catalog.offerSellUnits(context, [...new Set(offers.map((o) => o.offerId))]),
        this.sellers.sellingEligibility(context, [...new Set(offers.map((o) => o.sellerId))]),
      ]);
      if (!units.ok || !eligibility.ok) return null;
      const visible = new Set<Id<'Offer'>>();
      for (const { offerId, sellerId } of offers) {
        const offer = units.value.get(offerId);
        if (
          offer !== undefined &&
          offer.status === 'published' &&
          offer.listed &&
          offer.sellerId === sellerId &&
          eligibility.value.get(sellerId)?.eligible === true
        ) {
          visible.add(offerId);
        }
      }
      return visible;
    } catch {
      return null;
    }
  }
}
