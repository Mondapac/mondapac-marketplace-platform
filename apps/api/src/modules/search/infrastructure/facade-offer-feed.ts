import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { CatalogIndexFacade } from '../../catalog';
import type { FeedFacts, OfferFeed } from '../application/ports/offer-feed';

/** {@link OfferFeed} over catalog's index facade (system actor only). Any refusal is `null`. */
export class FacadeOfferFeed implements OfferFeed {
  constructor(private readonly catalog: CatalogIndexFacade) {}

  async facts(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
    locale: string,
  ): Promise<ReadonlyMap<Id<'Offer'>, FeedFacts> | null> {
    const answer = await this.catalog.offerSearchFacts(context, offerIds, locale);
    if (!answer.ok) return null;
    const facts = new Map<Id<'Offer'>, FeedFacts>();
    for (const [offerId, value] of answer.value) {
      facts.set(offerId, {
        sellerId: value.sellerId,
        productId: value.productId,
        sellable: value.sellable,
        name: value.text?.name ?? null,
        shortText: value.text?.shortDescription ?? null,
        categoryIds: value.categoryIds,
      });
    }
    return facts;
  }

  async publishedIds(
    context: CallContext,
    input: { productId?: Id<'Product'>; after?: Id<'Offer'>; limit: number },
  ): Promise<readonly Id<'Offer'>[] | null> {
    const answer = await this.catalog.publishedOfferIds(context, input);
    return answer.ok ? answer.value : null;
  }
}
