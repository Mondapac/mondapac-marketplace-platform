import type { CallContext } from '@mondapac/shared-kernel';
import type { WorkQueueCountQuery } from '../../../platform/work-queue/work-queue-count';
import type { CountPriceHolds } from '../application/use-cases/count-price-holds.use-case';
import type { PricingWorkQueueFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to each use case, so the gate runs. */
export class PricingWorkQueueFacadeImplementation implements PricingWorkQueueFacade {
  constructor(private readonly priceHoldsUseCase: CountPriceHolds) {}

  priceHolds(context: CallContext, query: WorkQueueCountQuery) {
    return this.priceHoldsUseCase.execute(context, query);
  }
}
