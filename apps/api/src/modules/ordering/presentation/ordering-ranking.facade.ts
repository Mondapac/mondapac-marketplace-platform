import type { CallContext } from '@mondapac/shared-kernel';
import type { BestSellingOffersQuery } from '../application/use-cases/best-selling-offers.use-case';
import type { OrderingRankingFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to the use case, so the gate runs. */
export class OrderingRankingFacadeImplementation implements OrderingRankingFacade {
  constructor(private readonly bestSelling: BestSellingOffersQuery) {}

  bestSellingOffers(context: CallContext, request: { readonly limit: number }) {
    return this.bestSelling.execute(context, request);
  }
}
