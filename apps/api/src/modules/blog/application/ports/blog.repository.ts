import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { OwnerType, PostContent, PostKind } from '../../domain/content';
import type { PostStatus, VersionState } from '../../domain/lifecycle';

// The store of the blog (blog.posts, post_versions, post_events, post_links, post_tags, categories,
// tags, redirects and seller_quotas). Every method runs inside the caller's unit of work and is
// scoped by the Market: a row of another Market is never found. A version's content is read and
// written whole: its links, tags and event details travel with it.

export type PostId = Id<'BlogPost'>;
export type VersionId = Id<'BlogPostVersion'>;
export type CategoryId = Id<'BlogCategory'>;
export type TagId = Id<'BlogTag'>;

export interface PostRecord {
  readonly id: PostId;
  readonly kind: PostKind;
  readonly slug: string;
  readonly ownerType: OwnerType;
  readonly sellerId: Id<'Seller'> | null;
  readonly status: PostStatus;
  readonly liveVersionId: VersionId | null;
  readonly draftVersionId: VersionId | null;
  readonly scheduledAt: Temporal.Instant | null;
  /** The admin who set `scheduledAt` (set exactly with it); credited as the publisher. */
  readonly scheduledBy: Id<'Account'> | null;
  readonly publishedAt: Temporal.Instant | null;
  readonly unpublishedAt: Temporal.Instant | null;
  readonly pausedReason: string | null;
  readonly featured: boolean;
  readonly quotaPeriod: string | null;
  readonly createdAt: Temporal.Instant;
  readonly createdBy: Id<'Account'>;
  readonly updatedAt: Temporal.Instant;
  readonly updatedBy: Id<'Account'>;
  /** Raised by every lock of the row; the aggregate version of the events of a unit. */
  readonly rowVersion: number;
}

export interface VersionRecord {
  readonly id: VersionId;
  readonly postId: PostId;
  readonly versionNo: number;
  readonly state: VersionState;
  /** The links here are all links of the version (the cards of the body included), in order. */
  readonly content: PostContent;
  readonly editedByReviewer: boolean;
  readonly createdAt: Temporal.Instant;
  readonly createdBy: Id<'Account'>;
  readonly updatedAt: Temporal.Instant;
  readonly submittedAt: Temporal.Instant | null;
  readonly submittedBy: Id<'Account'> | null;
  readonly decidedAt: Temporal.Instant | null;
  readonly decidedBy: Id<'Account'> | null;
  readonly decision: 'approved' | 'changes_requested' | null;
  readonly decisionNote: string | null;
  readonly selfApproved: boolean;
  readonly publishedAt: Temporal.Instant | null;
  readonly publishedBy: Id<'Account'> | null;
}

export type VersionSummary = Pick<
  VersionRecord,
  | 'id'
  | 'versionNo'
  | 'state'
  | 'createdAt'
  | 'createdBy'
  | 'editedByReviewer'
  | 'submittedAt'
  | 'decidedAt'
  | 'decision'
  | 'publishedAt'
>;

/** The position of a post in the due queue. */
export interface DueKey {
  readonly scheduledAt: Temporal.Instant;
  readonly id: PostId;
}

export interface PostChange {
  readonly slug?: string;
  readonly status?: PostStatus;
  readonly liveVersionId?: VersionId | null;
  readonly draftVersionId?: VersionId | null;
  /** Clearing `scheduledAt` (null) clears `scheduledBy` too; setting it needs `scheduledBy`. */
  readonly scheduledAt?: Temporal.Instant | null;
  readonly scheduledBy?: Id<'Account'> | null;
  readonly publishedAt?: Temporal.Instant | null;
  readonly unpublishedAt?: Temporal.Instant | null;
  readonly pausedReason?: string | null;
  readonly featured?: boolean;
  readonly quotaPeriod?: string | null;
}

export interface VersionChange {
  readonly state?: VersionState;
  readonly submittedAt?: Temporal.Instant | null;
  readonly submittedBy?: Id<'Account'> | null;
  readonly decidedAt?: Temporal.Instant | null;
  readonly decidedBy?: Id<'Account'> | null;
  readonly decision?: 'approved' | 'changes_requested' | null;
  readonly decisionNote?: string | null;
  readonly selfApproved?: boolean;
  readonly publishedAt?: Temporal.Instant | null;
  readonly publishedBy?: Id<'Account'> | null;
}

export interface Stamp {
  readonly at: Temporal.Instant;
  readonly by: Id<'Account'>;
}

export interface PostFilter {
  readonly statuses?: readonly PostStatus[];
  readonly kind?: PostKind;
  readonly ownerType?: OwnerType;
  readonly sellerId?: Id<'Seller'>;
}

/** A row of the admin or seller list: the post and the title of the version in work (or live). */
export interface PostListRow {
  readonly post: PostRecord;
  readonly title: string;
  /** The state of the open version, if any. */
  readonly openState: VersionState | null;
}

export interface PublicFilter {
  readonly kind?: PostKind;
  readonly categoryId?: CategoryId;
  readonly tagId?: TagId;
}

/** A live post with its live version. In a list the body is empty (`body: []`). */
export interface PublicRow {
  readonly post: PostRecord;
  readonly version: VersionRecord;
}

export interface CategoryRecord {
  readonly id: CategoryId;
  readonly slug: string;
  readonly position: number;
  /** Locale to name. */
  readonly names: ReadonlyMap<string, string>;
}

export interface TagRecord {
  readonly id: TagId;
  readonly slug: string;
  readonly name: string;
}

export interface RedirectRecord {
  readonly fromSlug: string;
  readonly postId: PostId;
}

export interface BlogRepository {
  // Posts
  insertPost(market: MarketContext, post: PostRecord): Promise<void>;
  findPost(market: MarketContext, id: PostId): Promise<PostRecord | null>;
  /** Like `findPost`, and takes the row's write lock for the rest of the unit (raises rowVersion). */
  lockPost(market: MarketContext, id: PostId): Promise<PostRecord | null>;
  findPostBySlug(market: MarketContext, slug: string): Promise<PostRecord | null>;
  updatePost(market: MarketContext, id: PostId, change: PostChange, stamp: Stamp): Promise<void>;
  /** No post and no redirect of another post holds the slug. */
  isSlugFree(market: MarketContext, slug: string, exceptPostId: PostId | null): Promise<boolean>;
  /** Newest first. */
  listPosts(
    market: MarketContext,
    filter: PostFilter,
    page: { readonly limit: number; readonly offset: number },
  ): Promise<readonly PostListRow[]>;
  /** Takes `featured` off the Market's featured post, if any. */
  clearFeatured(market: MarketContext, stamp: Stamp): Promise<void>;
  /**
   * Features the post. False when another post became featured at the same time (the unique key of
   * one featured post per Market refused it); the unit must then end with a refusal.
   */
  markFeatured(market: MarketContext, id: PostId, stamp: Stamp): Promise<boolean>;
  /**
   * Posts with an instant due: `scheduledAt <= now` and an approved open version, oldest first by
   * (`scheduledAt`, `id`), after the key `after` when given (keyset paging past skipped posts).
   */
  duePosts(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
    after: DueKey | null,
  ): Promise<readonly PostRecord[]>;
  /** Scheduled posts of a seller, at most `limit`. */
  scheduledPostsOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    limit: number,
  ): Promise<readonly PostRecord[]>;
  /** Published posts of a seller, at most `limit`. */
  publishedPostsOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    limit: number,
  ): Promise<readonly PostRecord[]>;

  // Versions
  insertVersion(market: MarketContext, version: VersionRecord): Promise<void>;
  findVersion(market: MarketContext, postId: PostId, id: VersionId): Promise<VersionRecord | null>;
  versionSummaries(market: MarketContext, postId: PostId): Promise<readonly VersionSummary[]>;
  /** The highest version number of the post, 0 when it has none. */
  lastVersionNo(market: MarketContext, postId: PostId): Promise<number>;
  updateVersion(
    market: MarketContext,
    postId: PostId,
    id: VersionId,
    change: VersionChange,
    at: Temporal.Instant,
  ): Promise<void>;
  /** Replaces the content of a version that is a draft (the database refuses any other). */
  replaceContent(
    market: MarketContext,
    postId: PostId,
    id: VersionId,
    content: PostContent,
    at: Temporal.Instant,
  ): Promise<void>;
  /** Sets the status of the event on the given versions. */
  setEventStatus(
    market: MarketContext,
    versionIds: readonly VersionId[],
    status: string,
    message: string | null,
  ): Promise<void>;

  // Redirects
  findRedirect(market: MarketContext, fromSlug: string): Promise<RedirectRecord | null>;
  insertRedirect(
    market: MarketContext,
    redirect: {
      readonly id: Id<'BlogRedirect'>;
      readonly fromSlug: string;
      readonly postId: PostId;
    },
    at: Temporal.Instant,
  ): Promise<void>;
  deleteRedirect(market: MarketContext, fromSlug: string): Promise<void>;

  // Quota
  quotaUsed(market: MarketContext, sellerId: Id<'Seller'>, period: string): Promise<number>;
  /** Adds one unit when `used < limit`, atomically; false when the month is used up. */
  consumeQuota(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    period: string,
    limit: number,
    at: Temporal.Instant,
  ): Promise<boolean>;

  // Public reads (live versions of published posts only)
  listPublished(
    market: MarketContext,
    filter: PublicFilter,
    page: { readonly limit: number; readonly offset: number },
  ): Promise<readonly PublicRow[]>;
  /** Live event posts that have not ended at `now`, soonest first. */
  upcomingEvents(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly PublicRow[]>;

  // Taxonomy
  listCategories(market: MarketContext): Promise<readonly CategoryRecord[]>;
  findCategory(market: MarketContext, id: CategoryId): Promise<CategoryRecord | null>;
  findCategoryBySlug(market: MarketContext, slug: string): Promise<CategoryRecord | null>;
  insertCategory(market: MarketContext, category: CategoryRecord, stamp: Stamp): Promise<void>;
  updateCategory(
    market: MarketContext,
    id: CategoryId,
    change: { readonly position: number; readonly names: ReadonlyMap<string, string> },
    stamp: Stamp,
  ): Promise<void>;
  categoryInUse(market: MarketContext, id: CategoryId): Promise<boolean>;
  deleteCategory(market: MarketContext, id: CategoryId): Promise<void>;
  listTags(market: MarketContext): Promise<readonly TagRecord[]>;
  findTags(market: MarketContext, ids: readonly TagId[]): Promise<readonly TagRecord[]>;
  findTagBySlug(market: MarketContext, slug: string): Promise<TagRecord | null>;
  insertTag(market: MarketContext, tag: TagRecord, stamp: Stamp): Promise<void>;
  tagInUse(market: MarketContext, id: TagId): Promise<boolean>;
  deleteTag(market: MarketContext, id: TagId): Promise<void>;
}

export const BLOG_REPOSITORY = Symbol('BLOG_REPOSITORY');
