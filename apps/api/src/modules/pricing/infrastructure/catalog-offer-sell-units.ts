import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { CatalogFacade } from '../../catalog';
import {
  MAX_OFFER_IDS_PER_CALL,
  OfferSellUnitsUnavailableError,
  type OfferSellUnitsSource,
  type PricedOfferView,
} from '../application/ports/offer-sell-units';

/**
 * {@link OfferSellUnitsSource} over catalog's facade `offerSellUnits` (pricing design 6.1 CF1;
 * catalog design 9.1). The caller's `CallContext` goes through unchanged, so catalog's gate runs.
 *
 * Until catalog slice 7 the facade's production binding is catalog's fail-closed placeholder
 * (ADR-0031 decision 6), which answers **absent for every Offer**: every seller write then
 * answers `pricing.offer-not-found`. Nothing here may turn an absent, refused or failed answer
 * into a present one; there is no flag, default or fallback.
 */
export class CatalogOfferSellUnits implements OfferSellUnitsSource {
  constructor(private readonly catalog: CatalogFacade) {}

  async sellUnitsOf(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, PricedOfferView>> {
    // Refused whole above the limit, never truncated (design 5.2, P-1).
    if (offerIds.length > MAX_OFFER_IDS_PER_CALL) {
      throw new OfferSellUnitsUnavailableError('batch.too-large');
    }
    const answer = await this.catalog.offerSellUnits(context, offerIds);
    if (!answer.ok) throw new OfferSellUnitsUnavailableError(answer.error.code);
    const requested = new Set(offerIds);
    const views = new Map<Id<'Offer'>, PricedOfferView>();
    for (const [offerId, offer] of answer.value) {
      // Only what was asked for: an extra key in the answer is ignored, never trusted.
      if (!requested.has(offerId)) continue;
      const deleted = offer.status === 'deleted';
      views.set(
        offerId,
        Object.freeze({
          sellerId: offer.sellerId,
          productId: offer.productId,
          deleted,
          // A deleted Offer has no priceable Variant, whatever the answer lists (P-1).
          priceableVariantIds: new Set(deleted ? [] : offer.sellUnits.map((u) => u.variantId)),
        }),
      );
    }
    return views;
  }
}
