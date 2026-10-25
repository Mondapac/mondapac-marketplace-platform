import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { BestSellingOffersQuery } from '../application/use-cases/best-selling-offers.use-case';
import type { BoughtTogetherQuery } from '../application/use-cases/bought-together.use-case';
import type { OrderingRankingFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to the use case, so the gate runs. */
export class OrderingRankingFacadeImplementation implements OrderingRankingFacade {
  constructor(
    private readonly bestSelling: BestSellingOffersQuery,
    private readonly boughtTogetherQuery: BoughtTogetherQuery,
  ) {}

  bestSellingOffers(context: CallContext, request: { readonly limit: number }) {
    return this.bestSelling.execute(context, request);
  }

  boughtTogether(
    context: CallContext,
    request: { readonly offerId: Id<'Offer'>; readonly limit: number },
  ) {
    return this.boughtTogetherQuery.execute(context, request);
  }
}
