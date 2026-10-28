import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { CatalogModule } from '../catalog';
import { CertificationModule } from '../certification';
import { SellersModule } from '../sellers';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import {
  registerPermissions,
  registerStepUpActions,
  STEP_UP_CONSUMER,
  USE_CASE_GATE,
  type UseCaseGate,
} from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerEvents } from '../../platform/events/event-catalogue';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { OUTBOX_WRITER } from '../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import type { BlogDependencies } from './application/blog-dependencies';
import { BLOG_LINKS } from './application/ports/blog-links';
import { BLOG_POLICY } from './application/ports/blog-policy';
import { BLOG_REPOSITORY } from './application/ports/blog.repository';
import { ApproveBlogPost } from './application/use-cases/approve-post.use-case';
import { ArchiveBlogPost } from './application/use-cases/archive-post.use-case';
import { ChangeBlogEventStatus } from './application/use-cases/change-event-status.use-case';
import { CreateBlogCategory } from './application/use-cases/create-category.use-case';
import { CreateBlogPost } from './application/use-cases/create-post.use-case';
import { CreateBlogTag } from './application/use-cases/create-tag.use-case';
import { DeleteBlogCategory } from './application/use-cases/delete-category.use-case';
import { DeleteBlogTag } from './application/use-cases/delete-tag.use-case';
import { FeatureBlogPost } from './application/use-cases/feature-post.use-case';
import { ListBlogPosts } from './application/use-cases/list-posts.use-case';
import { ListBlogTaxonomy } from './application/use-cases/list-taxonomy.use-case';
import { PauseBlogPost } from './application/use-cases/pause-post.use-case';
import { PauseSellerBlogPosts } from './application/use-cases/pause-seller-posts.use-case';
import { PrepareBlogPostCopy } from './application/use-cases/prepare-post-copy.use-case';
import { PublishDueBlogPosts } from './application/use-cases/publish-due.use-case';
import { PublishBlogPost } from './application/use-cases/publish-post.use-case';
import { RenameBlogPostSlug } from './application/use-cases/rename-post-slug.use-case';
import { RequestBlogPostChanges } from './application/use-cases/request-changes.use-case';
import { ResumeBlogPost } from './application/use-cases/resume-post.use-case';
import { EditBlogPostInReview } from './application/use-cases/reviewer-edit.use-case';
import { RunBlogPostChecks } from './application/use-cases/run-checks.use-case';
import { ScheduleBlogPost } from './application/use-cases/schedule-post.use-case';
import { ArchiveOwnBlogPost } from './application/use-cases/seller-archive-post.use-case';
import { ChangeOwnBlogEventStatus } from './application/use-cases/seller-change-event-status.use-case';
import { CreateOwnBlogPost } from './application/use-cases/seller-create-post.use-case';
import { ListOwnBlogPosts } from './application/use-cases/seller-list-posts.use-case';
import { ListBlogTaxonomyForSeller } from './application/use-cases/seller-list-taxonomy.use-case';
import { SubmitOwnBlogPost } from './application/use-cases/seller-submit-post.use-case';
import { UpdateOwnBlogPostDraft } from './application/use-cases/seller-update-draft.use-case';
import { ViewOwnBlogPost } from './application/use-cases/seller-view-post.use-case';
import { SubmitBlogPost } from './application/use-cases/submit-post.use-case';
import { UnscheduleBlogPost } from './application/use-cases/unschedule-post.use-case';
import { UpdateBlogCategory } from './application/use-cases/update-category.use-case';
import { UpdateBlogPostDraft } from './application/use-cases/update-draft.use-case';
import { ViewBlogPost } from './application/use-cases/view-post.use-case';
import { ViewPublicBlogTaxonomy } from './application/use-cases/view-public-taxonomy.use-case';
import { ViewPublishedBlogPost } from './application/use-cases/view-published-post.use-case';
import { ListPublishedBlogPosts } from './application/use-cases/view-published-posts.use-case';
import { ViewUpcomingBlogEvents } from './application/use-cases/view-upcoming-events.use-case';
import { BLOG_PERMISSIONS } from './contracts/permissions';
import { BLOG_STEP_UP_ACTIONS } from './contracts/step-up';
import { BLOG_AUDIT_ACTIONS } from './domain/audit';
import { BLOG_EVENTS } from './domain/events';
import { blogProviders } from './infrastructure/blog-providers';
import { AdminBlogController } from './presentation/admin-blog.controller';
import { AdminBlogTaxonomyController } from './presentation/admin-blog-taxonomy.controller';
import { publishDueJob } from './presentation/jobs/publish-due.job';
import { PublicBlogController } from './presentation/public-blog.controller';
import { SellerBlogController } from './presentation/seller-blog.controller';
import { sellerBlogAccessSubscriptions } from './presentation/subscribers/seller-blog-access.subscriptions';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: BlogDependencies) => U;

const PORTS: readonly [keyof BlogDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['posts', BLOG_REPOSITORY],
  ['policy', BLOG_POLICY],
  ['links', BLOG_LINKS],
  ['audit', AUDIT_WRITER],
  ['outbox', OUTBOX_WRITER],
  ['stepUp', STEP_UP_CONSUMER],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
];

/** Every blog use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as BlogDependencies,
      ),
  };
}

/**
 * Blog: posts of four kinds (product, brand, event, news) for the buyer site, written by the
 * platform's editors and, where an admin has switched a seller's blog access on, by sellers (four
 * posts a month by default). A post is a closed list of text blocks and typed cards, never HTML.
 * Every change is a version; a version is checked automatically, reviewed by a person other than
 * its author and made live by a person who holds the protected publish key (now, or at a scheduled
 * time by the worker). A published post can be paused at once; an old address redirects, and an
 * address taken off the site answers 410. Buyers read the live version with no session.
 */
@Module({
  imports: [CatalogModule, CertificationModule, SellersModule],
  controllers: [
    AdminBlogController,
    AdminBlogTaxonomyController,
    SellerBlogController,
    PublicBlogController,
  ],
  providers: [
    PersistenceModule.auditWriterFor('blog'),
    PersistenceModule.outboxWriterFor('blog'),
    registerAuditActions('blog', BLOG_AUDIT_ACTIONS),
    registerEvents('blog', BLOG_EVENTS),
    registerPermissions('blog', BLOG_PERMISSIONS),
    registerStepUpActions('blog', BLOG_STEP_UP_ACTIONS),
    ...blogProviders,
    ...[
      ApproveBlogPost,
      ArchiveBlogPost,
      ChangeBlogEventStatus,
      CreateBlogCategory,
      CreateBlogPost,
      CreateBlogTag,
      DeleteBlogCategory,
      DeleteBlogTag,
      FeatureBlogPost,
      ListBlogPosts,
      ListBlogTaxonomy,
      PauseBlogPost,
      PrepareBlogPostCopy,
      PublishBlogPost,
      RenameBlogPostSlug,
      RequestBlogPostChanges,
      ResumeBlogPost,
      EditBlogPostInReview,
      RunBlogPostChecks,
      ScheduleBlogPost,
      ArchiveOwnBlogPost,
      ChangeOwnBlogEventStatus,
      CreateOwnBlogPost,
      ListOwnBlogPosts,
      ListBlogTaxonomyForSeller,
      SubmitOwnBlogPost,
      UpdateOwnBlogPostDraft,
      ViewOwnBlogPost,
      SubmitBlogPost,
      UnscheduleBlogPost,
      UpdateBlogCategory,
      UpdateBlogPostDraft,
      ViewBlogPost,
      ViewPublicBlogTaxonomy,
      ViewPublishedBlogPost,
      ListPublishedBlogPosts,
      ViewUpcomingBlogEvents,
      PublishDueBlogPosts,
      PauseSellerBlogPosts,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    registerJobsFrom('blog', [PublishDueBlogPosts], (publishDue: PublishDueBlogPosts) => [
      publishDueJob(publishDue),
    ]),
    registerSubscriptionsFrom('blog', [PauseSellerBlogPosts], (pause: PauseSellerBlogPosts) =>
      sellerBlogAccessSubscriptions(pause),
    ),
  ],
})
export class BlogModule {}
