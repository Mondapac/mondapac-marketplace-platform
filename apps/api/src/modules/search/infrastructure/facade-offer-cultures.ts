import type { CallContext, Id } from '@mondapac/shared-kernel';
import { MAX_VISIBILITY_OFFERS, type CatalogCulturesFacade } from '../../catalog';
import type { OfferCultureSource } from '../application/ports/offer-cultures';

/**
 * {@link OfferCultureSource} over catalog's `visibleCultureCodesForOffers`, in
 * calls of at most {@link MAX_VISIBILITY_OFFERS} Offers. Any refusal or fault is `null`; there is
 * no partial answer.
 */
export class FacadeOfferCultures implements OfferCultureSource {
  constructor(private readonly cultures: CatalogCulturesFacade) {}

  async visibleCodes(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, readonly string[]> | null> {
    const distinct = [...new Set(offerIds)];
    const out = new Map<Id<'Offer'>, readonly string[]>();
    try {
      for (let at = 0; at < distinct.length; at += MAX_VISIBILITY_OFFERS) {
        const answer = await this.cultures.visibleCultureCodesForOffers(
          context,
          distinct.slice(at, at + MAX_VISIBILITY_OFFERS),
        );
        if (!answer.ok) return null;
        for (const [offerId, codes] of answer.value) out.set(offerId, [...codes]);
      }
    } catch {
      return null;
    }
    return out;
  }
}
