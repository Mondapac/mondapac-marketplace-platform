import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import {
  countSellerWorkQueue,
  type WorkQueueCountDependencies,
} from '../../../../platform/work-queue/count-work-queue';
import type {
  WorkQueueCount,
  WorkQueueCountQuery,
} from '../../../../platform/work-queue/work-queue-count';
import { REVIEWS_SELLER_VIEW } from '../../contracts/permissions';
import type { ReviewsWorkQueueCountReader } from '../ports/work-queue-count.reader';

/**
 * `reviews.count-seller-unanswered-reviews` (dashboards upgrade, phase 1, seller tasks): the
 * seller's own published reviews the shop has not replied to (the Reviews list's `unanswered`
 * view). Overdue: published before the age limit. Rule: the key `reviews.seller.view`, the
 * session's own seller only, denied while the seller is not approved (as the seller Reviews
 * list). One read-only unit; a count only, never review text or an author.
 */
export class CountSellerUnansweredReviews extends UseCase<
  WorkQueueCountQuery,
  WorkQueueCount,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.count-seller-unanswered-reviews',
    rule: { kind: 'permissions', allOf: [REVIEWS_SELLER_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WorkQueueCountDependencies<ReviewsWorkQueueCountReader>,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>> {
    return countSellerWorkQueue(this.deps, context, query, (counts, sellerId) =>
      counts.sellerUnanswered(context.market, sellerId, query.staleBefore),
    );
  }
}
