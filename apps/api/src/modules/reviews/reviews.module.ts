import { Temporal } from '@mondapac/shared-kernel';
import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { registerEvents } from '../../platform/events/event-catalogue';
import { OUTBOX_WRITER } from '../../platform/events/outbox-writer';
import {
  registerPermissions,
  registerStepUpActions,
  STEP_UP_CONSUMER,
  USE_CASE_GATE,
  type UseCaseGate,
} from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { ExceljsSheetWriter, SHEET_WRITER, type SheetWriter } from '../../platform/list-export';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { MarketRegistry } from '../../platform/market-config/market-registry';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { CATALOG_FACADE, CatalogModule } from '../catalog';
import { IdentityModule } from '../identity';
import { ListsModule, registerLists } from '../lists';
import { REVIEWS_MODERATION_LISTS } from './application/moderation-saved-filter-list';
import { REVIEWS_LISTS } from './application/saved-filter-list';
import { ORDERING_FACADE, OrderingModule } from '../ordering';
import { MARKET_SETTING_REPOSITORY } from './application/ports/market-setting.repository';
import { REVIEW_REPOSITORY } from './application/ports/review.repository';
import { CUSTOMER_REVIEWS_READER } from './application/ports/customer-reviews.reader';
import type { AdminCustomerReviewsDependencies } from './application/admin-customer-reviews';
import { AdminCustomerHelpfulVotes } from './application/use-cases/admin-customer-helpful-votes.use-case';
import { AdminCustomerReviewReports } from './application/use-cases/admin-customer-review-reports.use-case';
import { AdminCustomerReviews } from './application/use-cases/admin-customer-reviews.use-case';
import { AdminCustomerSellerRatings } from './application/use-cases/admin-customer-seller-ratings.use-case';
import { ReviewAuthorOf } from './application/use-cases/review-author-of.use-case';
import { REVIEWER_NAMES } from './application/ports/reviewer-names';
import { REVIEWS_POLICY } from './application/ports/reviews-policy';
import { SELLER_AFFINITY } from './application/ports/seller-affinity';
import { SELLER_OVERLAP_SOURCE } from './application/ports/seller-overlap';
import type { ReviewsDependencies } from './application/reviews-dependencies';
import { CastHelpfulVote } from './application/use-cases/cast-helpful-vote.use-case';
import { ListModerationQueue } from './application/use-cases/list-moderation-queue.use-case';
import { ModerateReview } from './application/use-cases/moderate-review.use-case';
import { RemoveReview } from './application/use-cases/remove-review.use-case';
import { ViewModerationReview } from './application/use-cases/view-moderation-review.use-case';
import { DeleteProductReview } from './application/use-cases/delete-product-review.use-case';
import { CountSellerReviews } from './application/use-cases/count-seller-reviews.use-case';
import { DetachAuthor } from './application/use-cases/detach-author.use-case';
import { EditProductReview } from './application/use-cases/edit-product-review.use-case';
import { ListMyReviews } from './application/use-cases/list-my-reviews.use-case';
import { ListProductRatingTotals } from './application/use-cases/list-product-rating-totals.use-case';
import { ListProductReviews } from './application/use-cases/list-product-reviews.use-case';
import { EditReviewReply } from './application/use-cases/edit-review-reply.use-case';
import { ExportModerationReviews } from './application/use-cases/export-moderation-reviews.use-case';
import { ModerationModerateProbe } from './application/use-cases/moderation-moderate-probe.use-case';
import { ModerationRemoveProbe } from './application/use-cases/moderation-remove-probe.use-case';
import { QueryModerationReviews } from './application/use-cases/query-moderation-reviews.use-case';
import {
  MODERATION_ROW_KEYS,
  type ModerationListDependencies,
} from './application/moderation-list-flow';
import { ExportSellerReviews } from './application/use-cases/export-seller-reviews.use-case';
import { QuerySellerReviews } from './application/use-cases/query-seller-reviews.use-case';
import { SellerReviewReplyProbe } from './application/use-cases/seller-review-reply-probe.use-case';
import { SellerReviewReportProbe } from './application/use-cases/seller-review-report-probe.use-case';
import {
  SELLER_REVIEW_ROW_KEYS,
  type SellerReviewListDependencies,
} from './application/seller-review-list-flow';
import { ListSellerReviews } from './application/use-cases/list-seller-reviews.use-case';
import { ReplyToReview } from './application/use-cases/reply-to-review.use-case';
import { ReportReview } from './application/use-cases/report-review.use-case';
import { ListToReview } from './application/use-cases/list-to-review.use-case';
import { RateSellerOrder } from './application/use-cases/rate-seller-order.use-case';
import { RebuildRatingSummaries } from './application/use-cases/rebuild-rating-summaries.use-case';
import { RemoveHelpfulVote } from './application/use-cases/remove-helpful-vote.use-case';
import { SetReviewsStatus } from './application/use-cases/set-reviews-status.use-case';
import { SubmitProductReview } from './application/use-cases/submit-product-review.use-case';
import { ViewProductSummary } from './application/use-cases/view-product-summary.use-case';
import { ViewReviewsSettings } from './application/use-cases/view-reviews-settings.use-case';
import { ViewSellerSummary } from './application/use-cases/view-seller-summary.use-case';
import {
  CUSTOMER_REVIEWS_FACADE,
  REVIEWS_AUDIT_ACTIONS,
  REVIEWS_FACADE,
  REVIEWS_PERMISSIONS,
  REVIEWS_STEP_UP_ACTIONS,
} from './contracts';
import { REVIEWS_EVENTS } from './domain/events';
import { reviewsProviders } from './infrastructure/reviews-providers';
import { rebuildRatingSummariesJob } from './presentation/jobs/rebuild-rating-summaries.job';
import {
  AdminModerationController,
  AdminReviewsController,
  BuyerReviewsController,
  PublicReviewsController,
} from './presentation/reviews.controller';
import { SellerReviewsController } from './presentation/seller-reviews.controller';
import { ReviewsFacadeImplementation } from './presentation/reviews.facade';
import { CustomerReviewsFacadeImplementation } from './presentation/customer-reviews.facade';

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
  ['overlap', SELLER_OVERLAP_SOURCE],
  ['audit', AUDIT_WRITER],
  ['outbox', OUTBOX_WRITER],
  ['stepUp', STEP_UP_CONSUMER],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
];

type CustomerReadClass<U> = new (gate: UseCaseGate, deps: AdminCustomerReviewsDependencies) => U;

/** The admin's reads of one customer (customers management phase 2b): their own, smaller deps. */
function customerReadProvider<U>(type: CustomerReadClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, UNIT_OF_WORK, CUSTOMER_REVIEWS_READER],
    useFactory: (
      gate: UseCaseGate,
      unitOfWork: AdminCustomerReviewsDependencies['unitOfWork'],
      reader: AdminCustomerReviewsDependencies['reader'],
    ) => new type(gate, { unitOfWork, reader }),
  };
}

/** The repair job's interval: the smallest `reviews.summaryRebuildMinutes` of the hosted Markets. */
function summaryRebuildEvery(markets: MarketRegistry): Temporal.Duration {
  const minutes = markets
    .hostedMarketIds()
    .map((id) => markets.get(id).reviews?.summaryRebuildMinutes ?? 1440);
  return Temporal.Duration.from({ minutes: minutes.length === 0 ? 1440 : Math.min(...minutes) });
}

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

type SellerListUseCaseClass<U> = new (gate: UseCaseGate, deps: SellerReviewListDependencies) => U;

/** The shop's review list and its export (super list 32) share one dependency object. */
function sellerListUseCaseProvider<U>(type: SellerListUseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [
      USE_CASE_GATE,
      UNIT_OF_WORK,
      REVIEW_REPOSITORY,
      MARKET_SETTING_REPOSITORY,
      REVIEWS_POLICY,
      SellerReviewReplyProbe,
      SellerReviewReportProbe,
      SHEET_WRITER,
      CLOCK,
    ],
    useFactory: (
      gate: UseCaseGate,
      unitOfWork: SellerReviewListDependencies['unitOfWork'],
      reviews: SellerReviewListDependencies['reviews'],
      settings: SellerReviewListDependencies['settings'],
      policy: SellerReviewListDependencies['policy'],
      reply: SellerReviewReplyProbe,
      report: SellerReviewReportProbe,
      sheetWriter: SellerReviewListDependencies['sheetWriter'],
      clock: SellerReviewListDependencies['clock'],
    ) => {
      const [replyKey, reportKey] = SELLER_REVIEW_ROW_KEYS;
      return new type(gate, {
        unitOfWork,
        reviews,
        settings,
        policy,
        probes: { [replyKey]: reply, [reportKey]: report },
        sheetWriter,
        clock,
      });
    },
  };
}

type ModerationListUseCaseClass<U> = new (gate: UseCaseGate, deps: ModerationListDependencies) => U;

/** The admin moderation list and its export (super list 18) share one dependency object. */
function moderationListUseCaseProvider<U>(type: ModerationListUseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [
      USE_CASE_GATE,
      UNIT_OF_WORK,
      REVIEW_REPOSITORY,
      ModerationModerateProbe,
      ModerationRemoveProbe,
      SHEET_WRITER,
      CLOCK,
    ],
    useFactory: (
      gate: UseCaseGate,
      unitOfWork: ModerationListDependencies['unitOfWork'],
      reviews: ModerationListDependencies['reviews'],
      moderate: ModerationModerateProbe,
      remove: ModerationRemoveProbe,
      sheetWriter: ModerationListDependencies['sheetWriter'],
      clock: ModerationListDependencies['clock'],
    ) => {
      const [moderateKey, removeKey] = MODERATION_ROW_KEYS;
      return new type(gate, {
        unitOfWork,
        reviews,
        probes: { [moderateKey]: moderate, [removeKey]: remove },
        sheetWriter,
        clock,
      });
    },
  };
}

/**
 * Reviews (buyer reviews and ratings, package 1): product reviews, seller ratings, the automatic
 * checks, the insert-only moderation log and rebuilt rating summaries, in the `reviews` schema.
 * Eligibility is asked of ordering through its facade at write time. The Market switch (off by
 * default) is moved at runtime by an admin. The admin moderation queue (package 2) publishes, hides, restores or removes a review with a reason
 * code, behind the admin's two-step proof. The seller's side (package 4) lists the shop's reviews, writes and edits one public reply and reports a review.
 */
@Module({
  imports: [OrderingModule, CatalogModule, IdentityModule, ListsModule],
  controllers: [
    BuyerReviewsController,
    PublicReviewsController,
    AdminReviewsController,
    AdminModerationController,
    SellerReviewsController,
  ],
  providers: [
    PersistenceModule.outboxWriterFor('reviews'),
    PersistenceModule.auditWriterFor('reviews'),
    registerEvents('reviews', REVIEWS_EVENTS),
    registerAuditActions('reviews', REVIEWS_AUDIT_ACTIONS),
    registerPermissions('reviews', REVIEWS_PERMISSIONS),
    registerStepUpActions('reviews', REVIEWS_STEP_UP_ACTIONS),
    // The seller Reviews list's saved filters, through the generic routes of `lists` (rule 14).
    registerLists('reviews', [...REVIEWS_LISTS, ...REVIEWS_MODERATION_LISTS]),
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
      ListModerationQueue,
      ViewModerationReview,
      ModerateReview,
      RemoveReview,
      RebuildRatingSummaries,
      DetachAuthor,
      CountSellerReviews,
      CastHelpfulVote,
      RemoveHelpfulVote,
      ListProductRatingTotals,
      ListSellerReviews,
      ReplyToReview,
      EditReviewReply,
      ReportReview,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    { provide: SHEET_WRITER, useFactory: (): SheetWriter => new ExceljsSheetWriter() },
    {
      provide: SellerReviewReplyProbe,
      inject: [USE_CASE_GATE],
      useFactory: (gate: UseCaseGate) => new SellerReviewReplyProbe(gate),
    },
    {
      provide: SellerReviewReportProbe,
      inject: [USE_CASE_GATE],
      useFactory: (gate: UseCaseGate) => new SellerReviewReportProbe(gate),
    },
    {
      provide: ModerationModerateProbe,
      inject: [USE_CASE_GATE],
      useFactory: (gate: UseCaseGate) => new ModerationModerateProbe(gate),
    },
    {
      provide: ModerationRemoveProbe,
      inject: [USE_CASE_GATE],
      useFactory: (gate: UseCaseGate) => new ModerationRemoveProbe(gate),
    },
    moderationListUseCaseProvider(QueryModerationReviews),
    moderationListUseCaseProvider(ExportModerationReviews),
    sellerListUseCaseProvider(QuerySellerReviews),
    sellerListUseCaseProvider(ExportSellerReviews),
    // Customers management phase 2b, part 3: the admin's reads of one customer's reviews.
    ...[
      AdminCustomerReviews,
      AdminCustomerSellerRatings,
      AdminCustomerHelpfulVotes,
      AdminCustomerReviewReports,
      ReviewAuthorOf,
    ].map((type) => customerReadProvider(type as CustomerReadClass<unknown>)),
    {
      provide: CUSTOMER_REVIEWS_FACADE,
      inject: [
        AdminCustomerReviews,
        AdminCustomerSellerRatings,
        AdminCustomerHelpfulVotes,
        AdminCustomerReviewReports,
        ReviewAuthorOf,
      ],
      useFactory: (
        reviews: AdminCustomerReviews,
        ratings: AdminCustomerSellerRatings,
        votes: AdminCustomerHelpfulVotes,
        reports: AdminCustomerReviewReports,
        author: ReviewAuthorOf,
      ) => new CustomerReviewsFacadeImplementation(reviews, ratings, votes, reports, author),
    },
    {
      provide: REVIEWS_FACADE,
      inject: [
        ViewProductSummary,
        ViewSellerSummary,
        DetachAuthor,
        ListProductRatingTotals,
        CountSellerReviews,
      ],
      useFactory: (
        product: ViewProductSummary,
        seller: ViewSellerSummary,
        detach: DetachAuthor,
        totals: ListProductRatingTotals,
        count: CountSellerReviews,
      ) => new ReviewsFacadeImplementation(product, seller, detach, totals, count),
    },
    registerJobsFrom(
      'reviews',
      [RebuildRatingSummaries, MarketRegistry],
      (rebuild: RebuildRatingSummaries, markets: MarketRegistry) => [
        rebuildRatingSummariesJob(rebuild, summaryRebuildEvery(markets)),
      ],
    ),
  ],
  exports: [REVIEWS_FACADE, CUSTOMER_REVIEWS_FACADE],
})
export class ReviewsModule {}
