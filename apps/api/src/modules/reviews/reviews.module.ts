import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { CATALOG_FACADE, CatalogModule } from '../catalog';
import { ORDERING_FACADE, OrderingModule } from '../ordering';
import { MARKET_SETTING_REPOSITORY } from './application/ports/market-setting.repository';
import { REVIEW_REPOSITORY } from './application/ports/review.repository';
import { REVIEWER_NAMES } from './application/ports/reviewer-names';
import { REVIEWS_POLICY } from './application/ports/reviews-policy';
import { SELLER_AFFINITY } from './application/ports/seller-affinity';
import type { ReviewsDependencies } from './application/reviews-dependencies';
import { DeleteProductReview } from './application/use-cases/delete-product-review.use-case';
import { DetachAuthor } from './application/use-cases/detach-author.use-case';
import { EditProductReview } from './application/use-cases/edit-product-review.use-case';
import { ListMyReviews } from './application/use-cases/list-my-reviews.use-case';
import { ListProductReviews } from './application/use-cases/list-product-reviews.use-case';
import { ListToReview } from './application/use-cases/list-to-review.use-case';
import { RateSellerOrder } from './application/use-cases/rate-seller-order.use-case';
import { RebuildRatingSummaries } from './application/use-cases/rebuild-rating-summaries.use-case';
import { SetReviewsStatus } from './application/use-cases/set-reviews-status.use-case';
import { SubmitProductReview } from './application/use-cases/submit-product-review.use-case';
import { ViewProductSummary } from './application/use-cases/view-product-summary.use-case';
import { ViewReviewsSettings } from './application/use-cases/view-reviews-settings.use-case';
import { ViewSellerSummary } from './application/use-cases/view-seller-summary.use-case';
import { REVIEWS_AUDIT_ACTIONS, REVIEWS_FACADE, REVIEWS_PERMISSIONS } from './contracts';
import { reviewsProviders } from './infrastructure/reviews-providers';
import { rebuildRatingSummariesJob } from './presentation/jobs/rebuild-rating-summaries.job';
import {
  AdminReviewsController,
  BuyerReviewsController,
  PublicReviewsController,
} from './presentation/reviews.controller';
import { ReviewsFacadeImplementation } from './presentation/reviews.facade';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: ReviewsDependencies) => U;

const PORTS: readonly [keyof ReviewsDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['reviews', REVIEW_REPOSITORY],
  ['settings', MARKET_SETTING_REPOSITORY],
  ['policy', REVIEWS_POLICY],
  ['ordering', ORDERING_FACADE],
  ['catalog', CATALOG_FACADE],
  ['names', REVIEWER_NAMES],
  ['affinity', SELLER_AFFINITY],
  ['audit', AUDIT_WRITER],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
];

/** Every reviews use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as ReviewsDependencies,
      ),
  };
}

/**
 * Reviews (buyer reviews and ratings, package 1): product reviews, seller ratings, the automatic
 * checks, the insert-only moderation log and rebuilt rating summaries, in the `reviews` schema.
 * Eligibility is asked of ordering through its facade at write time. The Market switch (off by
 * default) is moved at runtime by an admin. Sellers' replies, reports and the moderator queue
 * come in later packages.
 */
@Module({
  imports: [OrderingModule, CatalogModule],
  controllers: [BuyerReviewsController, PublicReviewsController, AdminReviewsController],
  providers: [
    PersistenceModule.auditWriterFor('reviews'),
    registerAuditActions('reviews', REVIEWS_AUDIT_ACTIONS),
    registerPermissions('reviews', REVIEWS_PERMISSIONS),
    ...reviewsProviders,
    ...[
      SubmitProductReview,
      EditProductReview,
      DeleteProductReview,
      RateSellerOrder,
      ListToReview,
      ListMyReviews,
      ListProductReviews,
      ViewProductSummary,
      ViewSellerSummary,
      ViewReviewsSettings,
      SetReviewsStatus,
      RebuildRatingSummaries,
      DetachAuthor,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    {
      provide: REVIEWS_FACADE,
      inject: [ViewProductSummary, ViewSellerSummary, DetachAuthor],
      useFactory: (product: ViewProductSummary, seller: ViewSellerSummary, detach: DetachAuthor) =>
        new ReviewsFacadeImplementation(product, seller, detach),
    },
    registerJobsFrom('reviews', [RebuildRatingSummaries], (rebuild: RebuildRatingSummaries) => [
      rebuildRatingSummariesJob(rebuild),
    ]),
  ],
  exports: [REVIEWS_FACADE],
})
export class ReviewsModule {}
