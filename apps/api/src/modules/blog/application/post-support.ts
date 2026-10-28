import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { Block } from '../domain/body';
import { linksOf } from '../domain/content';
import type { OwnerType, PostContent, PostKind, PostLink } from '../domain/content';
import type { EventDetails } from '../domain/event-details';
import type { Problems } from '../domain/fields';
import type { PostFacts, PostStatus, VersionState } from '../domain/lifecycle';
import type {
  BlogPostApproved as ApprovedEvent,
  BlogPostArchived as ArchivedEvent,
  BlogPostChangesRequested as ChangesRequestedEvent,
  BlogPostEditedByReviewer as EditedByReviewerEvent,
  BlogPostPaused as PausedEvent,
  BlogPostPublished as PublishedEvent,
  BlogPostResumed as ResumedEvent,
  BlogPostSubmitted as SubmittedEvent,
} from '../domain/events';
import type { BlogDependencies } from './blog-dependencies';
import type { BlogFailure } from './failures';
import type { BlogMarketPolicy } from './ports/blog-policy';
import type {
  PostId,
  PostRecord,
  VersionId,
  VersionRecord,
  VersionSummary,
} from './ports/blog.repository';

// The parts the blog's flows share: who is calling, the post a call names (locked and read with
// its versions), the facts the lifecycle asks, the events of a unit and the views the routes answer.

export interface AdminCaller {
  readonly accountId: Id<'Account'>;
}
export interface SellerCaller extends AdminCaller {
  readonly sellerId: Id<'Seller'>;
}

export function adminOf(context: CallContext): AdminCaller | null {
  const actor = context.actor;
  return actor.kind === 'authenticated' && actor.population === 'admin'
    ? { accountId: actor.accountId }
    : null;
}

export function sellerOf(context: CallContext): SellerCaller | null {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'seller' || actor.sellerId === null) {
    return null;
  }
  return { accountId: actor.accountId, sellerId: actor.sellerId };
}

/** The Market's blog settings, or null: the blog is unavailable in a Market without them. */
export const policyOf = (deps: BlogDependencies, market: MarketContext): BlogMarketPolicy | null =>
  deps.policy.of(market);

export function postIdOf(value: unknown): PostId | null {
  if (typeof value !== 'string') return null;
  const parsed = parseId<'BlogPost'>(value);
  return parsed.ok ? parsed.value : null;
}

export const fieldsOf = (problems: Problems): BlogFailure => ({
  code: 'validation.failed',
  fields: problems,
});

/** The facts the lifecycle asks of a post, from the post and its open version. */
export function factsOf(post: PostRecord, open: VersionRecord | null): PostFacts {
  return {
    status: post.status,
    hasLive: post.liveVersionId !== null,
    open: open?.state ?? null,
    everPublished: post.publishedAt !== null,
    scheduled: post.scheduledAt !== null,
  };
}

export interface LoadedPost {
  readonly post: PostRecord;
  /** The version the draft pointer names, if any. */
  readonly open: VersionRecord | null;
}

/** Reads the post and its open version (no lock). A post of another Market is not found. */
export async function loadPost(
  deps: BlogDependencies,
  market: MarketContext,
  raw: unknown,
): Promise<Result<LoadedPost, BlogFailure>> {
  const id = postIdOf(raw);
  if (id === null) return err({ code: 'blog.post-not-found' });
  const post = await deps.posts.findPost(market, id);
  if (post === null) return err({ code: 'blog.post-not-found' });
  return ok({ post, open: await openOf(deps, market, post) });
}

/** Like {@link loadPost}, and takes the post's write lock for the rest of the unit. */
export async function lockPost(
  deps: BlogDependencies,
  market: MarketContext,
  raw: unknown,
): Promise<Result<LoadedPost, BlogFailure>> {
  const id = postIdOf(raw);
  if (id === null) return err({ code: 'blog.post-not-found' });
  const post = await deps.posts.lockPost(market, id);
  if (post === null) return err({ code: 'blog.post-not-found' });
  return ok({ post, open: await openOf(deps, market, post) });
}

async function openOf(
  deps: BlogDependencies,
  market: MarketContext,
  post: PostRecord,
): Promise<VersionRecord | null> {
  return post.draftVersionId === null
    ? null
    : deps.posts.findVersion(market, post.id, post.draftVersionId);
}

/** A seller reaches only its own posts; any other post is `blog.post-not-found`, byte-identical. */
export const ownedBy = (post: PostRecord, seller: SellerCaller): boolean =>
  post.ownerType === 'seller' && post.sellerId === seller.sellerId;

type PostEventDefinition =
  | typeof SubmittedEvent
  | typeof ApprovedEvent
  | typeof ChangesRequestedEvent
  | typeof EditedByReviewerEvent
  | typeof PublishedEvent
  | typeof PausedEvent
  | typeof ResumedEvent
  | typeof ArchivedEvent;

/** One event per post per unit; the aggregate version is the post's row version after the lock. */
export async function emit(
  deps: BlogDependencies,
  context: CallContext,
  definition: PostEventDefinition,
  post: PostRecord,
  versionId: VersionId,
): Promise<void> {
  await deps.outbox.append(context, [
    definition.record({
      aggregateId: post.id,
      aggregateVersion: post.rowVersion,
      occurredAt: deps.clock.now(),
      payload: {
        postId: post.id,
        versionId,
        kind: post.kind,
        ownerType: post.ownerType,
        sellerId: post.sellerId,
      },
    }),
  ]);
}

/** The category and tags of a content must exist in the Market. */
export async function checkReferences(
  deps: BlogDependencies,
  market: MarketContext,
  content: PostContent,
): Promise<Problems> {
  const problems: Problems = [];
  if (content.categoryId !== null) {
    const category = await deps.posts.findCategory(
      market,
      content.categoryId as Id<'BlogCategory'>,
    );
    if (category === null) problems.push({ path: 'categoryId', code: 'not-found' });
  }
  if (content.tagIds.length > 0) {
    const found = await deps.posts.findTags(market, content.tagIds as Id<'BlogTag'>[]);
    const known = new Set(found.map((tag) => tag.id as string));
    for (const [index, id] of content.tagIds.entries()) {
      if (!known.has(id)) problems.push({ path: `tagIds[${index}]`, code: 'not-found' });
    }
  }
  return problems;
}

/** The content as a version stores it: every link of the version, the cards of the body first. */
export const storedContent = (content: PostContent): PostContent => ({
  ...content,
  links: linksOf(content),
});

export const MAX_VERSIONS = 100;

export interface NewVersionInput {
  readonly deps: BlogDependencies;
  readonly market: MarketContext;
  readonly post: PostRecord;
  readonly content: PostContent;
  readonly by: Id<'Account'>;
  readonly state: VersionState;
  readonly editedByReviewer?: boolean;
  readonly submittedAt?: Temporal.Instant | null;
  readonly submittedBy?: Id<'Account'> | null;
}

/** Inserts the next version of a post; `blog.version-limit` past the cap of 100. */
export async function insertNextVersion(
  input: NewVersionInput,
): Promise<Result<VersionRecord, BlogFailure>> {
  const { deps, market, post } = input;
  const versionNo = (await deps.posts.lastVersionNo(market, post.id)) + 1;
  if (versionNo > MAX_VERSIONS) return err({ code: 'blog.version-limit' });
  const at = deps.clock.now();
  const version: VersionRecord = {
    id: deps.ids.next<'BlogPostVersion'>(),
    postId: post.id,
    versionNo,
    state: input.state,
    content: storedContent(input.content),
    editedByReviewer: input.editedByReviewer ?? false,
    createdAt: at,
    createdBy: input.by,
    updatedAt: at,
    submittedAt: input.submittedAt ?? null,
    submittedBy: input.submittedBy ?? null,
    decidedAt: null,
    decidedBy: null,
    decision: null,
    decisionNote: null,
    selfApproved: false,
    publishedAt: null,
    publishedBy: null,
  };
  await deps.posts.insertVersion(market, version);
  return ok(version);
}

// ------------------------------------------------------------------------------------------
// Views

export interface EventView {
  readonly startsAt: Temporal.Instant;
  readonly endsAt: Temporal.Instant;
  readonly timeZone: string;
  readonly attendance: string;
  readonly venueName: string | null;
  readonly address: string | null;
  readonly registrationUrl: string | null;
  readonly eventStatus: string;
  readonly statusMessage: string | null;
}

export interface ContentView {
  readonly title: string;
  readonly excerpt: string;
  readonly body: readonly Block[];
  readonly coverImageId: string | null;
  readonly coverAlt: string | null;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
  readonly authorDisplay: string | null;
  readonly categoryId: string | null;
  readonly tagIds: readonly string[];
  readonly links: readonly PostLink[];
  readonly event: EventView | null;
}

export const eventView = (event: EventDetails): EventView => ({ ...event });

export const contentView = (content: PostContent): ContentView => ({
  title: content.title,
  excerpt: content.excerpt,
  body: content.body,
  coverImageId: content.coverImageId,
  coverAlt: content.coverAlt,
  seoTitle: content.seoTitle,
  seoDescription: content.seoDescription,
  authorDisplay: content.authorDisplay,
  categoryId: content.categoryId,
  tagIds: content.tagIds,
  links: content.links,
  event: content.event === null ? null : eventView(content.event),
});

export interface VersionView {
  readonly id: VersionId;
  readonly versionNo: number;
  readonly state: VersionState;
  readonly content: ContentView;
  readonly editedByReviewer: boolean;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  readonly submittedAt: Temporal.Instant | null;
  readonly decidedAt: Temporal.Instant | null;
  readonly decision: 'approved' | 'changes_requested' | null;
  /** The reviewer's note to the author when changes were requested. */
  readonly decisionNote: string | null;
  readonly selfApproved: boolean;
  readonly publishedAt: Temporal.Instant | null;
  /** Account ids of the people involved; only an admin's view carries them. */
  readonly people: {
    readonly createdBy: Id<'Account'>;
    readonly submittedBy: Id<'Account'> | null;
    readonly decidedBy: Id<'Account'> | null;
  } | null;
}

export const versionView = (version: VersionRecord, forAdmin: boolean): VersionView => ({
  id: version.id,
  versionNo: version.versionNo,
  state: version.state,
  content: contentView(version.content),
  editedByReviewer: version.editedByReviewer,
  createdAt: version.createdAt,
  updatedAt: version.updatedAt,
  submittedAt: version.submittedAt,
  decidedAt: version.decidedAt,
  decision: version.decision,
  decisionNote: version.decisionNote,
  selfApproved: version.selfApproved,
  publishedAt: version.publishedAt,
  people: forAdmin
    ? {
        createdBy: version.createdBy,
        submittedBy: version.submittedBy,
        decidedBy: version.decidedBy,
      }
    : null,
});

export interface PostSummaryView {
  readonly id: PostId;
  readonly kind: PostKind;
  readonly slug: string;
  readonly ownerType: OwnerType;
  readonly sellerId: Id<'Seller'> | null;
  readonly status: PostStatus;
  readonly openState: VersionState | null;
  readonly title: string;
  readonly featured: boolean;
  readonly scheduledAt: Temporal.Instant | null;
  readonly publishedAt: Temporal.Instant | null;
  readonly updatedAt: Temporal.Instant;
}

export interface PostDetailView extends Omit<PostSummaryView, 'title' | 'openState'> {
  readonly unpublishedAt: Temporal.Instant | null;
  readonly pausedReason: string | null;
  readonly quotaPeriod: string | null;
  readonly createdAt: Temporal.Instant;
  /** The version being worked on or reviewed, if any. */
  readonly open: VersionView | null;
  /** What buyers read now, if the post is on the site (or was and is paused). */
  readonly live: VersionView | null;
  /** The version history; `createdBy` (an account id) only in an admin's view. */
  readonly versions: readonly VersionHistoryView[];
}

export type VersionHistoryView = Omit<VersionSummary, 'createdBy'> &
  Partial<Pick<VersionSummary, 'createdBy'>>;

export const summaryView = (
  post: PostRecord,
  title: string,
  openState: VersionState | null,
): PostSummaryView => ({
  id: post.id,
  kind: post.kind,
  slug: post.slug,
  ownerType: post.ownerType,
  sellerId: post.sellerId,
  status: post.status,
  openState,
  title,
  featured: post.featured,
  scheduledAt: post.scheduledAt,
  publishedAt: post.publishedAt,
  updatedAt: post.updatedAt,
});

/** The detail of a post: both its working version and its live one, and the version list. */
export async function detailOf(
  deps: BlogDependencies,
  market: MarketContext,
  loaded: LoadedPost,
  forAdmin: boolean,
): Promise<PostDetailView> {
  const { post, open } = loaded;
  const live =
    post.liveVersionId === null
      ? null
      : await deps.posts.findVersion(market, post.id, post.liveVersionId);
  return {
    id: post.id,
    kind: post.kind,
    slug: post.slug,
    ownerType: post.ownerType,
    sellerId: post.sellerId,
    status: post.status,
    featured: post.featured,
    scheduledAt: post.scheduledAt,
    publishedAt: post.publishedAt,
    updatedAt: post.updatedAt,
    unpublishedAt: post.unpublishedAt,
    pausedReason: post.pausedReason,
    quotaPeriod: post.quotaPeriod,
    createdAt: post.createdAt,
    open: open === null ? null : versionView(open, forAdmin),
    live: live === null ? null : versionView(live, forAdmin),
    versions: (await deps.posts.versionSummaries(market, post.id)).map((version) => {
      if (forAdmin) return version;
      const { id, versionNo, state, createdAt, editedByReviewer, submittedAt, decidedAt } = version;
      return {
        id,
        versionNo,
        state,
        createdAt,
        editedByReviewer,
        submittedAt,
        decidedAt,
        decision: version.decision,
        publishedAt: version.publishedAt,
      };
    }),
  };
}
