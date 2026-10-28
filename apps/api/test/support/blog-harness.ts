import { Logger } from '@nestjs/common';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type {
  AuditEntry,
  CallContext,
  Id,
  IdGenerator,
  MarketContext,
  PendingEvent,
  Result,
} from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import type { AuthorisationCheck, StepUpProofConsumer } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import type { OutboxWriter } from '../../src/platform/events/outbox-writer';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import type { HandledOnce, UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import type { BlogDependencies } from '../../src/modules/blog/application/blog-dependencies';
import type { BlogRepository } from '../../src/modules/blog/application/ports/blog.repository';
import type { BlogLinks } from '../../src/modules/blog/application/ports/blog-links';
import type { ProductFact } from '../../src/modules/blog/domain/checks';
import { ConfigBlogPolicy } from '../../src/modules/blog/infrastructure/config-blog-policy';
import { ApproveBlogPost } from '../../src/modules/blog/application/use-cases/approve-post.use-case';
import { ArchiveBlogPost } from '../../src/modules/blog/application/use-cases/archive-post.use-case';
import { ChangeBlogEventStatus } from '../../src/modules/blog/application/use-cases/change-event-status.use-case';
import { CreateBlogCategory } from '../../src/modules/blog/application/use-cases/create-category.use-case';
import { CreateBlogPost } from '../../src/modules/blog/application/use-cases/create-post.use-case';
import { CreateBlogTag } from '../../src/modules/blog/application/use-cases/create-tag.use-case';
import { DeleteBlogCategory } from '../../src/modules/blog/application/use-cases/delete-category.use-case';
import { DeleteBlogTag } from '../../src/modules/blog/application/use-cases/delete-tag.use-case';
import { FeatureBlogPost } from '../../src/modules/blog/application/use-cases/feature-post.use-case';
import { ListBlogPosts } from '../../src/modules/blog/application/use-cases/list-posts.use-case';
import { ListBlogTaxonomy } from '../../src/modules/blog/application/use-cases/list-taxonomy.use-case';
import { PauseBlogPost } from '../../src/modules/blog/application/use-cases/pause-post.use-case';
import { PauseSellerBlogPosts } from '../../src/modules/blog/application/use-cases/pause-seller-posts.use-case';
import { PrepareBlogPostCopy } from '../../src/modules/blog/application/use-cases/prepare-post-copy.use-case';
import { PublishDueBlogPosts } from '../../src/modules/blog/application/use-cases/publish-due.use-case';
import { PublishBlogPost } from '../../src/modules/blog/application/use-cases/publish-post.use-case';
import { RenameBlogPostSlug } from '../../src/modules/blog/application/use-cases/rename-post-slug.use-case';
import { RequestBlogPostChanges } from '../../src/modules/blog/application/use-cases/request-changes.use-case';
import { ResumeBlogPost } from '../../src/modules/blog/application/use-cases/resume-post.use-case';
import { EditBlogPostInReview } from '../../src/modules/blog/application/use-cases/reviewer-edit.use-case';
import { RunBlogPostChecks } from '../../src/modules/blog/application/use-cases/run-checks.use-case';
import { ScheduleBlogPost } from '../../src/modules/blog/application/use-cases/schedule-post.use-case';
import { ArchiveOwnBlogPost } from '../../src/modules/blog/application/use-cases/seller-archive-post.use-case';
import { ChangeOwnBlogEventStatus } from '../../src/modules/blog/application/use-cases/seller-change-event-status.use-case';
import { CreateOwnBlogPost } from '../../src/modules/blog/application/use-cases/seller-create-post.use-case';
import { ListOwnBlogPosts } from '../../src/modules/blog/application/use-cases/seller-list-posts.use-case';
import { ListBlogTaxonomyForSeller } from '../../src/modules/blog/application/use-cases/seller-list-taxonomy.use-case';
import { SubmitOwnBlogPost } from '../../src/modules/blog/application/use-cases/seller-submit-post.use-case';
import { UpdateOwnBlogPostDraft } from '../../src/modules/blog/application/use-cases/seller-update-draft.use-case';
import { ViewOwnBlogPost } from '../../src/modules/blog/application/use-cases/seller-view-post.use-case';
import { SubmitBlogPost } from '../../src/modules/blog/application/use-cases/submit-post.use-case';
import { UnscheduleBlogPost } from '../../src/modules/blog/application/use-cases/unschedule-post.use-case';
import { UpdateBlogCategory } from '../../src/modules/blog/application/use-cases/update-category.use-case';
import { UpdateBlogPostDraft } from '../../src/modules/blog/application/use-cases/update-draft.use-case';
import { ViewBlogPost } from '../../src/modules/blog/application/use-cases/view-post.use-case';
import { ViewPublicBlogTaxonomy } from '../../src/modules/blog/application/use-cases/view-public-taxonomy.use-case';
import { ViewPublishedBlogPost } from '../../src/modules/blog/application/use-cases/view-published-post.use-case';
import { ListPublishedBlogPosts } from '../../src/modules/blog/application/use-cases/view-published-posts.use-case';
import { ViewUpcomingBlogEvents } from '../../src/modules/blog/application/use-cases/view-upcoming-events.use-case';
import { MemoryBlogRepository } from './memory-blog-repository';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from './test-config';

// A blog suite in memory on one Market fixture (AU or the synthetic ZZ): every use case behind the
// real gate, an authorisation check that holds the keys a test grants, the in-memory store with
// rollback of a refused unit, and fakes for the other modules. Nothing here is the PostgreSQL
// behaviour; that is test/db/blog-schema.db-spec.ts.

export const START = Temporal.Instant.from('2026-10-28T10:00:00Z');
export const markets = new MarketRegistry(
  loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS),
);

/** What the other modules answer, set per test. */
export class FakeLinks implements BlogLinks {
  /** Product id to the sellers that sell it; absent: not on sale. */
  readonly onSale = new Map<string, Set<string>>();
  readonly sellerAccess = new Map<string, boolean>();
  /** A text containing one of these (lower case) makes a certification claim. */
  claimTerms: string[] = ['iso certified'];
  productsDown = false;
  claimsDown = false;
  accessDown = false;

  products(
    _context: CallContext,
    productIds: readonly string[],
    sellerId: string | null,
  ): Promise<Result<ReadonlyMap<string, ProductFact>, { code: 'blog.unavailable' }>> {
    if (this.productsDown) return Promise.resolve(err({ code: 'blog.unavailable' }));
    const facts = new Map<string, ProductFact>();
    for (const id of productIds) {
      const sellers = this.onSale.get(id);
      if (sellers !== undefined) {
        facts.set(id, { onSale: true, soldBySeller: sellerId !== null && sellers.has(sellerId) });
      }
    }
    return Promise.resolve(ok(facts));
  }

  sellerBlogEnabled(
    _context: CallContext,
    sellerId: string,
  ): Promise<Result<boolean, { code: 'blog.unavailable' }>> {
    if (this.accessDown) return Promise.resolve(err({ code: 'blog.unavailable' }));
    return Promise.resolve(ok(this.sellerAccess.get(sellerId) ?? false));
  }

  claimsFlagged(
    _context: CallContext,
    texts: readonly { readonly locale: string; readonly text: string }[],
  ): Promise<Result<readonly boolean[], { code: 'blog.unavailable' }>> {
    if (this.claimsDown) return Promise.resolve(err({ code: 'blog.unavailable' }));
    return Promise.resolve(
      ok(
        texts.map(({ text }) => this.claimTerms.some((term) => text.toLowerCase().includes(term))),
      ),
    );
  }
}

/** A store, unit of work and writers to run the harness against instead of the in-memory ones. */
export interface BlogBacking {
  readonly posts: BlogRepository;
  readonly unitOfWork: UnitOfWork;
  readonly outbox?: OutboxWriter;
  readonly ids: IdGenerator;
}

export function blogHarness(code: 'AU' | 'ZZ', backing?: BlogBacking) {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(START);
  const ids = backing?.ids ?? new SequenceIdGenerator(clock);
  const repo = new MemoryBlogRepository();
  const links = new FakeLinks();
  const audits: AuditEntry[] = [];
  const events: PendingEvent[] = [];
  const grants = new Map<string, Set<string>>();
  /** Accounts that hold a fresh step-up proof for the self-approval. */
  const proofs = new Set<string>();
  const handled = new Set<string>();

  const audit: AuditWriter = {
    record: (_context, entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  const outbox: OutboxWriter = {
    append: (context, appended) => {
      events.push(...appended);
      return backing?.outbox?.append(context, appended) ?? Promise.resolve();
    },
  };
  const stepUp: StepUpProofConsumer = {
    consume: (context, actionKey) => {
      const actor = context.actor;
      if (actor.kind === 'authenticated' && proofs.delete(actor.accountId)) {
        return Promise.resolve(
          ok({ sessionId: actor.sessionId, verifiedAt: clock.now().subtract({ minutes: 1 }) }),
        );
      }
      return Promise.resolve(err({ code: 'second-factor.required', actionKey }));
    },
  };
  const authorisation: AuthorisationCheck = {
    check: (context, declaration) => {
      const actor = context.actor;
      const held =
        actor.kind === 'authenticated' ? (grants.get(actor.accountId) ?? new Set()) : new Set();
      const rule = declaration.rule;
      const needed = rule.kind === 'permissions' ? rule.allOf : [];
      return Promise.resolve(
        needed.every((key) => held.has(key))
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      );
    },
  };
  const gate = createUseCaseGate(markets, authorisation);

  /** Runs the work; a refusal rolls the store, the audit rows and the events back, as a unit does. */
  async function atomic<T, E>(work: () => Promise<Result<T, E>>): Promise<Result<T, E>> {
    const tables = repo.snapshot();
    const auditCount = audits.length;
    const eventCount = events.length;
    let done: Result<T, E>;
    try {
      done = await work();
    } catch (error) {
      repo.restore(tables);
      audits.length = auditCount;
      events.length = eventCount;
      throw error;
    }
    if (!done.ok) {
      repo.restore(tables);
      audits.length = auditCount;
      events.length = eventCount;
    }
    return done;
  }
  const unitOfWork: UnitOfWork = {
    run: (_market, work) => atomic(work),
    runOnce: async <T, E>(
      m: MarketContext,
      delivery: { eventId: string; subscriber: string },
      work: () => Promise<Result<T, E>>,
    ): Promise<Result<HandledOnce<T>, E>> => {
      const k = `${m.marketId}|${delivery.eventId}|${delivery.subscriber}`;
      if (handled.has(k)) return ok({ handled: false });
      const done = await atomic(work);
      if (!done.ok) return done;
      handled.add(k);
      return ok({ handled: true, value: done.value });
    },
  };

  const deps: BlogDependencies = {
    unitOfWork: backing?.unitOfWork ?? unitOfWork,
    posts: backing?.posts ?? repo,
    policy: new ConfigBlogPolicy(markets),
    links,
    audit,
    outbox,
    stepUp,
    ids,
    clock,
  };

  const accountOf = new Map<string, Id<'Account'>>();
  const account = (name: string): Id<'Account'> => {
    let id = accountOf.get(name);
    if (id === undefined) {
      id = ids.next<'Account'>();
      accountOf.set(name, id);
    }
    return id;
  };

  /** A signed-in admin by name (the same name is the same account), holding these keys. */
  const admin = (name: string, keys: readonly string[]): CallContext => {
    const accountId = account(`admin:${name}`);
    grants.set(accountId, new Set(keys));
    return testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
  };

  /** A signed-in member of a seller's team, holding these keys. */
  const seller = (sellerId: Id<'Seller'>, keys: readonly string[], name = 'owner'): CallContext => {
    const accountId = account(`seller:${sellerId}:${name}`);
    grants.set(accountId, new Set(keys));
    return testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId,
      }),
    );
  };

  const cases = {
    approvePost: new ApproveBlogPost(gate, deps),
    archivePost: new ArchiveBlogPost(gate, deps),
    changeEventStatus: new ChangeBlogEventStatus(gate, deps),
    createCategory: new CreateBlogCategory(gate, deps),
    createPost: new CreateBlogPost(gate, deps),
    createTag: new CreateBlogTag(gate, deps),
    deleteCategory: new DeleteBlogCategory(gate, deps),
    deleteTag: new DeleteBlogTag(gate, deps),
    featurePost: new FeatureBlogPost(gate, deps),
    listPosts: new ListBlogPosts(gate, deps),
    listTaxonomy: new ListBlogTaxonomy(gate, deps),
    pausePost: new PauseBlogPost(gate, deps),
    pauseSellerPosts: new PauseSellerBlogPosts(gate, deps),
    preparePostCopy: new PrepareBlogPostCopy(gate, deps),
    publishDue: new PublishDueBlogPosts(gate, deps),
    publishPost: new PublishBlogPost(gate, deps),
    renamePostSlug: new RenameBlogPostSlug(gate, deps),
    requestChanges: new RequestBlogPostChanges(gate, deps),
    resumePost: new ResumeBlogPost(gate, deps),
    reviewerEdit: new EditBlogPostInReview(gate, deps),
    runChecks: new RunBlogPostChecks(gate, deps),
    schedulePost: new ScheduleBlogPost(gate, deps),
    sellerArchivePost: new ArchiveOwnBlogPost(gate, deps),
    sellerChangeEventStatus: new ChangeOwnBlogEventStatus(gate, deps),
    sellerCreatePost: new CreateOwnBlogPost(gate, deps),
    sellerListPosts: new ListOwnBlogPosts(gate, deps),
    sellerListTaxonomy: new ListBlogTaxonomyForSeller(gate, deps),
    sellerSubmitPost: new SubmitOwnBlogPost(gate, deps),
    sellerUpdateDraft: new UpdateOwnBlogPostDraft(gate, deps),
    sellerViewPost: new ViewOwnBlogPost(gate, deps),
    submitPost: new SubmitBlogPost(gate, deps),
    unschedulePost: new UnscheduleBlogPost(gate, deps),
    updateCategory: new UpdateBlogCategory(gate, deps),
    updateDraft: new UpdateBlogPostDraft(gate, deps),
    viewPost: new ViewBlogPost(gate, deps),
    viewPublicTaxonomy: new ViewPublicBlogTaxonomy(gate, deps),
    viewPublishedPost: new ViewPublishedBlogPost(gate, deps),
    viewPublishedPosts: new ListPublishedBlogPosts(gate, deps),
    viewUpcomingEvents: new ViewUpcomingBlogEvents(gate, deps),
  };

  return {
    market,
    clock,
    ids,
    repo,
    links,
    audits,
    events,
    deps,
    cases,
    admin,
    seller,
    anonymous: () => testCallContext(market, 'anonymous'),
    system: () => testCallContext(market, 'system'),
    /** Lets the account (by its context) spend one step-up proof. */
    proof: (context: CallContext) => {
      if (context.actor.kind === 'authenticated') proofs.add(context.actor.accountId);
    },
    revoke: (context: CallContext) => {
      if (context.actor.kind === 'authenticated') grants.set(context.actor.accountId, new Set());
    },
    handled,
  };
}

export type BlogHarness = ReturnType<typeof blogHarness>;

export function quietLogs(): void {
  beforeAll(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  afterAll(() => jest.restoreAllMocks());
}

const uuid = (n: number): string => `0197b000-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const COVER = uuid(1);
export const OTHER_IMAGE = uuid(2);
export const PRODUCT_A = uuid(10);
export const PRODUCT_B = uuid(11);
export const BRAND_A = uuid(20);
