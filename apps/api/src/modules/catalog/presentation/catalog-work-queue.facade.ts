import type { CallContext } from '@mondapac/shared-kernel';
import type { WorkQueueCountQuery } from '../../../platform/work-queue/work-queue-count';
import type { CountPendingOffers } from '../application/use-cases/count-pending-offers.use-case';
import type { CountPendingRevisions } from '../application/use-cases/count-pending-revisions.use-case';
import type { CountBrandMerges } from '../application/use-cases/count-brand-merges.use-case';
import type { CountCategoryProposals } from '../application/use-cases/count-category-proposals.use-case';
import type { CatalogWorkQueueFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to each use case, so the gate runs. */
export class CatalogWorkQueueFacadeImplementation implements CatalogWorkQueueFacade {
  constructor(
    private readonly pendingOffersUseCase: CountPendingOffers,
    private readonly pendingRevisionsUseCase: CountPendingRevisions,
    private readonly brandMergesUseCase: CountBrandMerges,
    private readonly categoryProposalsUseCase: CountCategoryProposals,
  ) {}

  pendingOffers(context: CallContext, query: WorkQueueCountQuery) {
    return this.pendingOffersUseCase.execute(context, query);
  }

  pendingRevisions(context: CallContext, query: WorkQueueCountQuery) {
    return this.pendingRevisionsUseCase.execute(context, query);
  }

  brandMerges(context: CallContext, query: WorkQueueCountQuery) {
    return this.brandMergesUseCase.execute(context, query);
  }

  categoryProposals(context: CallContext, query: WorkQueueCountQuery) {
    return this.categoryProposalsUseCase.execute(context, query);
  }
}
