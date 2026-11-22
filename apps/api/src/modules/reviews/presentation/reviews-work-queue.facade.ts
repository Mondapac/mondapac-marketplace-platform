import type { CallContext } from '@mondapac/shared-kernel';
import type { WorkQueueCountQuery } from '../../../platform/work-queue/work-queue-count';
import type { CountSellerUnansweredReviews } from '../application/use-cases/count-seller-unanswered-reviews.use-case';
import type { ReviewsWorkQueueFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to the use case, so the gate runs. */
export class ReviewsWorkQueueFacadeImplementation implements ReviewsWorkQueueFacade {
  constructor(private readonly unanswered: CountSellerUnansweredReviews) {}

  sellerUnanswered(context: CallContext, query: WorkQueueCountQuery) {
    return this.unanswered.execute(context, query);
  }
}
