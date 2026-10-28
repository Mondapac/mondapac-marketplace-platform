import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  BlogRepository,
  CategoryId,
  CategoryRecord,
  DueKey,
  PostChange,
  PostFilter,
  PostId,
  PostListRow,
  PostRecord,
  PublicFilter,
  PublicRow,
  RedirectRecord,
  Stamp,
  TagId,
  TagRecord,
  VersionChange,
  VersionId,
  VersionRecord,
  VersionSummary,
} from '../../src/modules/blog/application/ports/blog.repository';
import type { PostContent } from '../../src/modules/blog/domain/content';

// The blog store in memory, for use-case suites. Records are replaced, never changed in place, so
// a snapshot is a shallow copy of the maps and a refused unit rolls back by restoring it. It keeps
// the Market scope of every row. The constraints PostgreSQL enforces (CHECKs, triggers, unique
// indexes) are covered by test/db/blog-schema.db-spec.ts, not here.

interface Tables {
  posts: Map<string, PostRecord>;
  versions: Map<string, VersionRecord>;
  redirects: Map<string, { id: string; fromSlug: string; postId: PostId }>;
  quotas: Map<string, number>;
  categories: Map<string, CategoryRecord>;
  tags: Map<string, TagRecord>;
}

const key = (market: MarketContext, id: string): string => `${market.marketId}|${id}`;
const inMarket = (market: MarketContext, k: string): boolean => k.startsWith(`${market.marketId}|`);

export class MemoryBlogRepository implements BlogRepository {
  private t: Tables = {
    posts: new Map(),
    versions: new Map(),
    redirects: new Map(),
    quotas: new Map(),
    categories: new Map(),
    tags: new Map(),
  };

  snapshot(): Tables {
    return {
      posts: new Map(this.t.posts),
      versions: new Map(this.t.versions),
      redirects: new Map(this.t.redirects),
      quotas: new Map(this.t.quotas),
      categories: new Map(this.t.categories),
      tags: new Map(this.t.tags),
    };
  }

  restore(tables: Tables): void {
    this.t = tables;
  }

  // ------------------------------------------------------------------------------ test reads

  allPosts(market: MarketContext): PostRecord[] {
    return [...this.t.posts].filter(([k]) => inMarket(market, k)).map(([, post]) => post);
  }

  allVersions(market: MarketContext, postId: PostId): VersionRecord[] {
    return [...this.t.versions]
      .filter(([k, v]) => inMarket(market, k) && v.postId === postId)
      .map(([, v]) => v)
      .sort((a, b) => a.versionNo - b.versionNo);
  }

  // ----------------------------------------------------------------------------------- posts

  insertPost(market: MarketContext, post: PostRecord): Promise<void> {
    this.t.posts.set(key(market, post.id), post);
    return Promise.resolve();
  }

  findPost(market: MarketContext, id: PostId): Promise<PostRecord | null> {
    return Promise.resolve(this.t.posts.get(key(market, id)) ?? null);
  }

  lockPost(market: MarketContext, id: PostId): Promise<PostRecord | null> {
    const post = this.t.posts.get(key(market, id));
    if (post === undefined) return Promise.resolve(null);
    const locked = { ...post, rowVersion: post.rowVersion + 1 };
    this.t.posts.set(key(market, id), locked);
    return Promise.resolve(locked);
  }

  findPostBySlug(market: MarketContext, slug: string): Promise<PostRecord | null> {
    return Promise.resolve(this.allPosts(market).find((post) => post.slug === slug) ?? null);
  }

  updatePost(market: MarketContext, id: PostId, change: PostChange, stamp: Stamp): Promise<void> {
    const post = this.t.posts.get(key(market, id));
    if (post === undefined) return Promise.resolve();
    this.t.posts.set(key(market, id), {
      ...post,
      ...change,
      ...(change.scheduledAt === null && change.scheduledBy === undefined
        ? { scheduledBy: null }
        : {}),
      updatedAt: stamp.at,
      updatedBy: stamp.by,
    });
    return Promise.resolve();
  }

  isSlugFree(market: MarketContext, slug: string, exceptPostId: PostId | null): Promise<boolean> {
    if (this.allPosts(market).some((post) => post.slug === slug)) return Promise.resolve(false);
    const redirect = [...this.t.redirects]
      .filter(([k]) => inMarket(market, k))
      .map(([, r]) => r)
      .find((r) => r.fromSlug === slug);
    return Promise.resolve(redirect === undefined || redirect.postId === exceptPostId);
  }

  listPosts(
    market: MarketContext,
    filter: PostFilter,
    page: { readonly limit: number; readonly offset: number },
  ): Promise<readonly PostListRow[]> {
    const rows = this.allPosts(market)
      .filter(
        (post) =>
          (filter.statuses === undefined || filter.statuses.includes(post.status)) &&
          (filter.kind === undefined || post.kind === filter.kind) &&
          (filter.ownerType === undefined || post.ownerType === filter.ownerType) &&
          (filter.sellerId === undefined || post.sellerId === filter.sellerId),
      )
      .sort(
        (a, b) =>
          compareInstants(b.createdAt, a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      .slice(page.offset, page.offset + page.limit);
    return Promise.resolve(
      rows.map((post) => {
        const draft =
          post.draftVersionId === null
            ? undefined
            : this.t.versions.get(key(market, post.draftVersionId));
        const live =
          post.liveVersionId === null
            ? undefined
            : this.t.versions.get(key(market, post.liveVersionId));
        return {
          post,
          title: (draft ?? live)?.content.title ?? '',
          openState: draft === undefined ? null : draft.state,
        };
      }),
    );
  }

  markFeatured(market: MarketContext, id: PostId, stamp: Stamp): Promise<boolean> {
    return this.updatePost(market, id, { featured: true }, stamp).then(() => true);
  }

  clearFeatured(market: MarketContext, stamp: Stamp): Promise<void> {
    for (const post of this.allPosts(market)) {
      if (post.featured) {
        this.t.posts.set(key(market, post.id), {
          ...post,
          featured: false,
          updatedAt: stamp.at,
          updatedBy: stamp.by,
        });
      }
    }
    return Promise.resolve();
  }

  duePosts(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
    after: DueKey | null,
  ): Promise<readonly PostRecord[]> {
    const order = (a: PostRecord | DueKey, b: PostRecord | DueKey): number =>
      compareInstants(a.scheduledAt!, b.scheduledAt!) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return Promise.resolve(
      this.allPosts(market)
        .filter((post) => {
          if (post.scheduledAt === null || compareInstants(post.scheduledAt, now) > 0) return false;
          if (after !== null && order(post, after) <= 0) return false;
          const draft =
            post.draftVersionId === null
              ? undefined
              : this.t.versions.get(key(market, post.draftVersionId));
          return draft !== undefined && draft.state === 'approved';
        })
        .sort(order)
        .slice(0, limit),
    );
  }

  scheduledPostsOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    limit: number,
  ): Promise<readonly PostRecord[]> {
    return Promise.resolve(
      this.allPosts(market)
        .filter((post) => post.sellerId === sellerId && post.scheduledAt !== null)
        .slice(0, limit),
    );
  }

  publishedPostsOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    limit: number,
  ): Promise<readonly PostRecord[]> {
    return Promise.resolve(
      this.allPosts(market)
        .filter((post) => post.sellerId === sellerId && post.status === 'published')
        .slice(0, limit),
    );
  }

  // ------------------------------------------------------------------------------- versions

  insertVersion(market: MarketContext, version: VersionRecord): Promise<void> {
    this.t.versions.set(key(market, version.id), version);
    return Promise.resolve();
  }

  findVersion(market: MarketContext, postId: PostId, id: VersionId): Promise<VersionRecord | null> {
    const version = this.t.versions.get(key(market, id));
    return Promise.resolve(version !== undefined && version.postId === postId ? version : null);
  }

  versionSummaries(market: MarketContext, postId: PostId): Promise<readonly VersionSummary[]> {
    return Promise.resolve(
      this.allVersions(market, postId)
        .reverse()
        .map((v) => ({
          id: v.id,
          versionNo: v.versionNo,
          state: v.state,
          createdAt: v.createdAt,
          createdBy: v.createdBy,
          editedByReviewer: v.editedByReviewer,
          submittedAt: v.submittedAt,
          decidedAt: v.decidedAt,
          decision: v.decision,
          publishedAt: v.publishedAt,
        })),
    );
  }

  lastVersionNo(market: MarketContext, postId: PostId): Promise<number> {
    return Promise.resolve(
      Math.max(0, ...this.allVersions(market, postId).map((v) => v.versionNo)),
    );
  }

  updateVersion(
    market: MarketContext,
    postId: PostId,
    id: VersionId,
    change: VersionChange,
    at: Temporal.Instant,
  ): Promise<void> {
    const version = this.t.versions.get(key(market, id));
    if (version === undefined || version.postId !== postId) return Promise.resolve();
    this.t.versions.set(key(market, id), { ...version, ...change, updatedAt: at });
    return Promise.resolve();
  }

  replaceContent(
    market: MarketContext,
    postId: PostId,
    id: VersionId,
    content: PostContent,
    at: Temporal.Instant,
  ): Promise<void> {
    const version = this.t.versions.get(key(market, id));
    if (version === undefined || version.postId !== postId) return Promise.resolve();
    if (version.state !== 'draft') throw new Error('only a draft version changes its content');
    this.t.versions.set(key(market, id), { ...version, content, updatedAt: at });
    return Promise.resolve();
  }

  setEventStatus(
    market: MarketContext,
    versionIds: readonly VersionId[],
    status: string,
    message: string | null,
  ): Promise<void> {
    for (const id of versionIds) {
      const version = this.t.versions.get(key(market, id));
      if (version?.content.event) {
        this.t.versions.set(key(market, id), {
          ...version,
          content: {
            ...version.content,
            event: {
              ...version.content.event,
              eventStatus: status as never,
              statusMessage: message,
            },
          },
        });
      }
    }
    return Promise.resolve();
  }

  // ----------------------------------------------------------------------------- redirects

  findRedirect(market: MarketContext, fromSlug: string): Promise<RedirectRecord | null> {
    const found = [...this.t.redirects]
      .filter(([k]) => inMarket(market, k))
      .map(([, r]) => r)
      .find((r) => r.fromSlug === fromSlug);
    return Promise.resolve(found ? { fromSlug: found.fromSlug, postId: found.postId } : null);
  }

  insertRedirect(
    market: MarketContext,
    redirect: {
      readonly id: Id<'BlogRedirect'>;
      readonly fromSlug: string;
      readonly postId: PostId;
    },
  ): Promise<void> {
    this.t.redirects.set(key(market, redirect.fromSlug), { ...redirect });
    return Promise.resolve();
  }

  deleteRedirect(market: MarketContext, fromSlug: string): Promise<void> {
    this.t.redirects.delete(key(market, fromSlug));
    return Promise.resolve();
  }

  // -------------------------------------------------------------------------------- quota

  quotaUsed(market: MarketContext, sellerId: Id<'Seller'>, period: string): Promise<number> {
    return Promise.resolve(this.t.quotas.get(key(market, `${sellerId}|${period}`)) ?? 0);
  }

  consumeQuota(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    period: string,
    limit: number,
  ): Promise<boolean> {
    const k = key(market, `${sellerId}|${period}`);
    const used = this.t.quotas.get(k) ?? 0;
    if (used >= limit) return Promise.resolve(false);
    this.t.quotas.set(k, used + 1);
    return Promise.resolve(true);
  }

  // -------------------------------------------------------------------------------- public

  private liveRows(market: MarketContext): PublicRow[] {
    return this.allPosts(market)
      .filter((post) => post.status === 'published' && post.liveVersionId !== null)
      .flatMap((post) => {
        const version = this.t.versions.get(key(market, post.liveVersionId!));
        return version === undefined
          ? []
          : [{ post, version: { ...version, content: { ...version.content, body: [] } } }];
      });
  }

  listPublished(
    market: MarketContext,
    filter: PublicFilter,
    page: { readonly limit: number; readonly offset: number },
  ): Promise<readonly PublicRow[]> {
    return Promise.resolve(
      this.liveRows(market)
        .filter(
          (row) =>
            (filter.kind === undefined || row.post.kind === filter.kind) &&
            (filter.categoryId === undefined ||
              row.version.content.categoryId === filter.categoryId) &&
            (filter.tagId === undefined || row.version.content.tagIds.includes(filter.tagId)),
        )
        .sort(
          (a, b) =>
            Number(b.post.featured) - Number(a.post.featured) ||
            compareInstants(b.post.publishedAt!, a.post.publishedAt!) ||
            (a.post.id < b.post.id ? 1 : -1),
        )
        .slice(page.offset, page.offset + page.limit),
    );
  }

  upcomingEvents(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly PublicRow[]> {
    return Promise.resolve(
      this.liveRows(market)
        .filter(
          (row) =>
            row.post.kind === 'event' &&
            row.version.content.event !== null &&
            compareInstants(row.version.content.event.endsAt, now) > 0,
        )
        .sort((a, b) =>
          compareInstants(a.version.content.event!.startsAt, b.version.content.event!.startsAt),
        )
        .slice(0, limit),
    );
  }

  // ------------------------------------------------------------------------------ taxonomy

  listCategories(market: MarketContext): Promise<readonly CategoryRecord[]> {
    return Promise.resolve(
      [...this.t.categories]
        .filter(([k]) => inMarket(market, k))
        .map(([, c]) => c)
        .sort((a, b) => a.position - b.position || (a.slug < b.slug ? -1 : 1)),
    );
  }

  findCategory(market: MarketContext, id: CategoryId): Promise<CategoryRecord | null> {
    return Promise.resolve(this.t.categories.get(key(market, id)) ?? null);
  }

  async findCategoryBySlug(market: MarketContext, slug: string): Promise<CategoryRecord | null> {
    return (await this.listCategories(market)).find((c) => c.slug === slug) ?? null;
  }

  insertCategory(market: MarketContext, category: CategoryRecord): Promise<void> {
    this.t.categories.set(key(market, category.id), category);
    return Promise.resolve();
  }

  updateCategory(
    market: MarketContext,
    id: CategoryId,
    change: { readonly position: number; readonly names: ReadonlyMap<string, string> },
  ): Promise<void> {
    const category = this.t.categories.get(key(market, id));
    if (category !== undefined) {
      this.t.categories.set(key(market, id), { ...category, ...change });
    }
    return Promise.resolve();
  }

  categoryInUse(market: MarketContext, id: CategoryId): Promise<boolean> {
    return Promise.resolve(
      [...this.t.versions].some(([k, v]) => inMarket(market, k) && v.content.categoryId === id),
    );
  }

  deleteCategory(market: MarketContext, id: CategoryId): Promise<void> {
    this.t.categories.delete(key(market, id));
    return Promise.resolve();
  }

  listTags(market: MarketContext): Promise<readonly TagRecord[]> {
    return Promise.resolve(
      [...this.t.tags].filter(([k]) => inMarket(market, k)).map(([, tag]) => tag),
    );
  }

  async findTags(market: MarketContext, ids: readonly TagId[]): Promise<readonly TagRecord[]> {
    return (await this.listTags(market)).filter((tag) => ids.includes(tag.id));
  }

  async findTagBySlug(market: MarketContext, slug: string): Promise<TagRecord | null> {
    return (await this.listTags(market)).find((tag) => tag.slug === slug) ?? null;
  }

  insertTag(market: MarketContext, tag: TagRecord): Promise<void> {
    this.t.tags.set(key(market, tag.id), tag);
    return Promise.resolve();
  }

  tagInUse(market: MarketContext, id: TagId): Promise<boolean> {
    return Promise.resolve(
      [...this.t.versions].some(([k, v]) => inMarket(market, k) && v.content.tagIds.includes(id)),
    );
  }

  deleteTag(market: MarketContext, id: TagId): Promise<void> {
    this.t.tags.delete(key(market, id));
    return Promise.resolve();
  }
}

function compareInstants(a: Temporal.Instant, b: Temporal.Instant): number {
  return a.epochMilliseconds - b.epochMilliseconds;
}
