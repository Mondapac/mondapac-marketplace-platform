import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { CatalogFacade } from '../../catalog';
import type { PublishedVariants } from '../application/ports/published-variants';

/** {@link PublishedVariants} over catalog's `offerSellUnits`; any refusal or failure is `null`. */
export class FacadePublishedVariants implements PublishedVariants {
  constructor(private readonly catalog: CatalogFacade) {}

  async published(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, ReadonlySet<Id<'Variant'>>> | null> {
    if (offerIds.length === 0) return new Map();
    try {
      const units = await this.catalog.offerSellUnits(context, [...new Set(offerIds)]);
      if (!units.ok) return null;
      const published = new Map<Id<'Offer'>, ReadonlySet<Id<'Variant'>>>();
      for (const [offerId, offer] of units.value) {
        published.set(
          offerId,
          new Set(offer.sellUnits.filter((u) => u.state === 'published').map((u) => u.variantId)),
        );
      }
      return published;
    } catch {
      return null;
    }
  }
}
