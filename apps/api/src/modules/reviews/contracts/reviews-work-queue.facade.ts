import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type {
  WorkQueueCount,
  WorkQueueCountQuery,
} from '../../../platform/work-queue/work-queue-count';

/**
 * The reviews queues of the seller dashboard's tasks (dashboards upgrade, phase 1, PR 6). Each
 * method runs one use case with the caller's `CallContext` unchanged (rule `reviews.seller.view`,
 * the session's own seller). Not exposed over HTTP; the dashboard module composes them.
 */
export interface ReviewsWorkQueueFacade {
  /** The session seller's published reviews without a reply of the shop. */
  sellerUnanswered(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>>;
}

/** Nest token of the {@link ReviewsWorkQueueFacade}, provided and exported by `ReviewsModule`. */
export const REVIEWS_WORK_QUEUE_FACADE = Symbol('REVIEWS_WORK_QUEUE_FACADE');
