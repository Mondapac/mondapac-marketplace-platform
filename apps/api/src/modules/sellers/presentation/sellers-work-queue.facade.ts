import type { CallContext } from '@mondapac/shared-kernel';
import type { WorkQueueCountQuery } from '../../../platform/work-queue/work-queue-count';
import type { CountSellerApplications } from '../application/use-cases/count-seller-applications.use-case';
import type { CountUnhealthySellers } from '../application/use-cases/count-unhealthy-sellers.use-case';
import type { SellersWorkQueueFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to each use case, so the gate runs. */
export class SellersWorkQueueFacadeImplementation implements SellersWorkQueueFacade {
  constructor(
    private readonly applicationsUseCase: CountSellerApplications,
    private readonly unhealthySellersUseCase: CountUnhealthySellers,
  ) {}

  applications(context: CallContext, query: WorkQueueCountQuery) {
    return this.applicationsUseCase.execute(context, query);
  }

  unhealthySellers(context: CallContext, query: WorkQueueCountQuery) {
    return this.unhealthySellersUseCase.execute(context, query);
  }
}
