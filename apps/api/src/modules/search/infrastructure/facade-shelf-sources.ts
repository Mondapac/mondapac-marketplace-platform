import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { OrderingRankingFacade } from '../../ordering';
import type { PricingSpecialsFacade } from '../../pricing';
import type { ShelfSources, ShelfSpecial } from '../application/ports/shelf-sources';

/**
 * {@link ShelfSources} over ordering's ranking facade and pricing's specials facade, both called
 * with the request's context unchanged. Any refusal or failure is `null`: the caller fails closed.
 */
export class FacadeShelfSources implements ShelfSources {
  constructor(
    private readonly ordering: OrderingRankingFacade,
    private readonly pricing: PricingSpecialsFacade,
  ) {}

  async bestSellingOfferIds(
    context: CallContext,
    limit: number,
  ): Promise<readonly Id<'Offer'>[] | null> {
    try {
      const result = await this.ordering.bestSellingOffers(context, { limit });
      return result.ok ? result.value : null;
    } catch {
      return null;
    }
  }

  async boughtTogetherOfferIds(
    context: CallContext,
    offerId: Id<'Offer'>,
    limit: number,
  ): Promise<readonly Id<'Offer'>[] | null> {
    try {
      const result = await this.ordering.boughtTogether(context, { offerId, limit });
      return result.ok ? result.value : null;
    } catch {
      return null;
    }
  }

  async specials(context: CallContext, limit: number): Promise<readonly ShelfSpecial[] | null> {
    try {
      const result = await this.pricing.specialsInForce(context, { limit });
      return result.ok ? result.value : null;
    } catch {
      return null;
    }
  }
}
