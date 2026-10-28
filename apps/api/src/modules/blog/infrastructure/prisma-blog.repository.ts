import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  BlogRepository,
  CategoryId,
  CategoryRecord,
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
} from '../application/ports/blog.repository';
import type { Block } from '../domain/body';
import type { LinkType, OwnerType, PostContent, PostKind } from '../domain/content';
import type { Attendance, EventStatus } from '../domain/event-details';
import type { PostStatus, VersionState } from '../domain/lifecycle';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const toInstantOrNull = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : toInstant(date);
const dateOrNull = (instant: Temporal.Instant | null): Date | null =>
  instant === null ? null : toDate(instant);

interface PostRow {
  readonly id: string;
  readonly kind: string;
  readonly slug: string;
  readonly ownerType: string;
  readonly sellerId: string | null;
  readonly status: string;
  readonly liveVersionId: string | null;
  readonly draftVersionId: string | null;
  readonly scheduledAt: Date | null;
  readonly publishedAt: Date | null;
  readonly unpublishedAt: Date | null;
  readonly pausedReason: string | null;
  readonly featured: boolean;
  readonly quotaPeriod: string | null;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly updatedAt: Date;
  readonly updatedBy: string;
  readonly rowVersion: number;
}

const toPost = (row: PostRow): PostRecord => ({
  id: row.id as PostId,
  kind: row.kind as PostKind,
  slug: row.slug,
  ownerType: row.ownerType as OwnerType,
  sellerId: row.sellerId as Id<'Seller'> | null,
  status: row.status as PostStatus,
  liveVersionId: row.liveVersionId as VersionId | null,
  draftVersionId: row.draftVersionId as VersionId | null,
  scheduledAt: toInstantOrNull(row.scheduledAt),
  publishedAt: toInstantOrNull(row.publishedAt),
  unpublishedAt: toInstantOrNull(row.unpublishedAt),
  pausedReason: row.pausedReason,
  featured: row.featured,
  quotaPeriod: row.quotaPeriod,
  createdAt: toInstant(row.createdAt),
  createdBy: row.createdBy as Id<'Account'>,
  updatedAt: toInstant(row.updatedAt),
  updatedBy: row.updatedBy as Id<'Account'>,
  rowVersion: row.rowVersion,
});

interface VersionRow {
  readonly id: string;
  readonly postId: string;
  readonly versionNo: number;
  readonly state: string;
  readonly title: string;
  readonly excerpt: string;
  readonly body?: unknown;
  readonly coverImageId: string | null;
  readonly coverAlt: string | null;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
  readonly authorDisplay: string | null;
  readonly categoryId: string | null;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly updatedAt: Date;
  readonly editedByReviewer: boolean;
  readonly submittedAt: Date | null;
  readonly submittedBy: string | null;
  readonly decidedAt: Date | null;
  readonly decidedBy: string | null;
  readonly decision: string | null;
  readonly decisionNote: string | null;
  readonly selfApproved: boolean;
  readonly publishedAt: Date | null;
  readonly publishedBy: string | null;
  readonly event: {
    readonly startsAt: Date;
    readonly endsAt: Date;
    readonly timeZone: string;
    readonly attendance: string;
    readonly venueName: string | null;
    readonly address: string | null;
    readonly registrationUrl: string | null;
    readonly eventStatus: string;
    readonly statusMessage: string | null;
  } | null;
  readonly links?: readonly { readonly targetType: string; readonly targetRef: string }[];
  readonly tags: readonly { readonly tagId: string }[];
}

const toVersion = (row: VersionRow): VersionRecord => ({
  id: row.id as VersionId,
  postId: row.postId as PostId,
  versionNo: row.versionNo,
  state: row.state as VersionState,
  content: {
    title: row.title,
    excerpt: row.excerpt,
    body: (row.body ?? []) as readonly Block[],
    coverImageId: row.coverImageId,
    coverAlt: row.coverAlt,
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
    authorDisplay: row.authorDisplay,
    categoryId: row.categoryId,
    tagIds: row.tags.map((tag) => tag.tagId),
    links: (row.links ?? []).map((link) => ({
      type: link.targetType as LinkType,
      id: link.targetRef,
    })),
    event:
      row.event === null
        ? null
        : {
            startsAt: toInstant(row.event.startsAt),
            endsAt: toInstant(row.event.endsAt),
            timeZone: row.event.timeZone,
            attendance: row.event.attendance as Attendance,
            venueName: row.event.venueName,
            address: row.event.address,
            registrationUrl: row.event.registrationUrl,
            eventStatus: row.event.eventStatus as EventStatus,
            statusMessage: row.event.statusMessage,
          },
  },
  editedByReviewer: row.editedByReviewer,
  createdAt: toInstant(row.createdAt),
  createdBy: row.createdBy as Id<'Account'>,
  updatedAt: toInstant(row.updatedAt),
  submittedAt: toInstantOrNull(row.submittedAt),
  submittedBy: row.submittedBy as Id<'Account'> | null,
  decidedAt: toInstantOrNull(row.decidedAt),
  decidedBy: row.decidedBy as Id<'Account'> | null,
  decision: row.decision as VersionRecord['decision'],
  decisionNote: row.decisionNote,
  selfApproved: row.selfApproved,
  publishedAt: toInstantOrNull(row.publishedAt),
  publishedBy: row.publishedBy as Id<'Account'> | null,
});

const FULL_VERSION = {
  event: true,
  links: { orderBy: { position: 'asc' as const } },
  tags: { orderBy: { tagId: 'asc' as const } },
};
const LIST_VERSION = { event: true, tags: { orderBy: { tagId: 'asc' as const } } };

/** {@link BlogRepository} on the `blog` schema, scoped by `marketId` in every `where`. */
export class PrismaBlogRepository implements BlogRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------------------------ posts

  async insertPost(market: MarketContext, post: PostRecord): Promise<void> {
    await this.prisma.tx(market).blogPost.create({
      data: {
        id: post.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        kind: post.kind,
        slug: post.slug,
        ownerType: post.ownerType,
        sellerId: post.sellerId,
        status: post.status,
        liveVersionId: post.liveVersionId,
        draftVersionId: post.draftVersionId,
        scheduledAt: dateOrNull(post.scheduledAt),
        publishedAt: dateOrNull(post.publishedAt),
        unpublishedAt: dateOrNull(post.unpublishedAt),
        pausedReason: post.pausedReason,
        featured: post.featured,
        quotaPeriod: post.quotaPeriod,
        createdAt: toDate(post.createdAt),
        createdBy: post.createdBy,
        updatedAt: toDate(post.updatedAt),
        updatedBy: post.updatedBy,
        rowVersion: post.rowVersion,
      },
    });
  }

  async findPost(market: MarketContext, id: PostId): Promise<PostRecord | null> {
    const row = await this.prisma.tx(market).blogPost.findFirst({
      where: { marketId: market.marketId, id },
    });
    return row === null ? null : toPost(row);
  }

  async lockPost(market: MarketContext, id: PostId): Promise<PostRecord | null> {
    // Raising the row version takes the row lock until the unit ends (the guarded client sends no
    // raw SQL) and writes no other column; the read after it sees what committed before the lock.
    const { count } = await this.prisma.tx(market).blogPost.updateMany({
      where: { marketId: market.marketId, id },
      data: { rowVersion: { increment: 1 } },
    });
    return count === 0 ? null : this.findPost(market, id);
  }

  async findPostBySlug(market: MarketContext, slug: string): Promise<PostRecord | null> {
    const row = await this.prisma.tx(market).blogPost.findFirst({
      where: { marketId: market.marketId, slug },
    });
    return row === null ? null : toPost(row);
  }

  async updatePost(
    market: MarketContext,
    id: PostId,
    change: PostChange,
    stamp: Stamp,
  ): Promise<void> {
    const data: Record<string, unknown> = { updatedAt: toDate(stamp.at), updatedBy: stamp.by };
    if (change.slug !== undefined) data.slug = change.slug;
    if (change.status !== undefined) data.status = change.status;
    if (change.liveVersionId !== undefined) data.liveVersionId = change.liveVersionId;
    if (change.draftVersionId !== undefined) data.draftVersionId = change.draftVersionId;
    if (change.scheduledAt !== undefined) data.scheduledAt = dateOrNull(change.scheduledAt);
    if (change.publishedAt !== undefined) data.publishedAt = dateOrNull(change.publishedAt);
    if (change.unpublishedAt !== undefined) data.unpublishedAt = dateOrNull(change.unpublishedAt);
    if (change.pausedReason !== undefined) data.pausedReason = change.pausedReason;
    if (change.featured !== undefined) data.featured = change.featured;
    if (change.quotaPeriod !== undefined) data.quotaPeriod = change.quotaPeriod;
    await this.prisma.tx(market).blogPost.updateMany({
      where: { marketId: market.marketId, id },
      data,
    });
  }

  async isSlugFree(
    market: MarketContext,
    slug: string,
    exceptPostId: PostId | null,
  ): Promise<boolean> {
    const db = this.prisma.tx(market);
    const post = await db.blogPost.findFirst({
      where: { marketId: market.marketId, slug },
      select: { id: true },
    });
    if (post !== null) return false;
    const redirect = await db.blogRedirect.findFirst({
      where: { marketId: market.marketId, fromSlug: slug },
      select: { postId: true },
    });
    return redirect === null || redirect.postId === exceptPostId;
  }

  async listPosts(
    market: MarketContext,
    filter: PostFilter,
    page: { readonly limit: number; readonly offset: number },
  ): Promise<readonly PostListRow[]> {
    const rows = await this.prisma.tx(market).blogPost.findMany({
      where: {
        marketId: market.marketId,
        ...(filter.statuses === undefined ? {} : { status: { in: [...filter.statuses] } }),
        ...(filter.kind === undefined ? {} : { kind: filter.kind }),
        ...(filter.ownerType === undefined ? {} : { ownerType: filter.ownerType }),
        ...(filter.sellerId === undefined ? {} : { sellerId: filter.sellerId }),
      },
      include: {
        draftVersion: { select: { title: true, state: true } },
        liveVersion: { select: { title: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.limit,
      skip: page.offset,
    });
    return rows.map((row) => ({
      post: toPost(row),
      title: row.draftVersion?.title ?? row.liveVersion?.title ?? '',
      openState: (row.draftVersion?.state ?? null) as VersionState | null,
    }));
  }

  async clearFeatured(market: MarketContext, stamp: Stamp): Promise<void> {
    await this.prisma.tx(market).blogPost.updateMany({
      where: { marketId: market.marketId, featured: true },
      data: { featured: false, updatedAt: toDate(stamp.at), updatedBy: stamp.by },
    });
  }

  async duePosts(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly PostRecord[]> {
    const rows = await this.prisma.tx(market).blogPost.findMany({
      where: {
        marketId: market.marketId,
        scheduledAt: { not: null, lte: toDate(now) },
        draftVersion: { is: { state: 'approved' } },
      },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(toPost);
  }

  async publishedPostsOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    limit: number,
  ): Promise<readonly PostRecord[]> {
    const rows = await this.prisma.tx(market).blogPost.findMany({
      where: { marketId: market.marketId, sellerId, status: 'published' },
      orderBy: [{ id: 'asc' }],
      take: limit,
    });
    return rows.map(toPost);
  }

  // -------------------------------------------------------------------------------- versions

  async insertVersion(market: MarketContext, version: VersionRecord): Promise<void> {
    const db = this.prisma.tx(market);
    const content = version.content;
    await db.blogPostVersion.create({
      data: {
        id: version.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        postId: version.postId,
        versionNo: version.versionNo,
        state: version.state,
        title: content.title,
        excerpt: content.excerpt,
        body: content.body as unknown as object[],
        coverImageId: content.coverImageId,
        coverAlt: content.coverAlt,
        seoTitle: content.seoTitle,
        seoDescription: content.seoDescription,
        authorDisplay: content.authorDisplay,
        categoryId: content.categoryId,
        createdAt: toDate(version.createdAt),
        createdBy: version.createdBy,
        updatedAt: toDate(version.updatedAt),
        editedByReviewer: version.editedByReviewer,
        submittedAt: dateOrNull(version.submittedAt),
        submittedBy: version.submittedBy,
        decidedAt: dateOrNull(version.decidedAt),
        decidedBy: version.decidedBy,
        decision: version.decision,
        decisionNote: version.decisionNote,
        selfApproved: version.selfApproved,
        publishedAt: dateOrNull(version.publishedAt),
        publishedBy: version.publishedBy,
      },
    });
    await this.writeChildren(market, version.id, content);
  }

  private async writeChildren(
    market: MarketContext,
    versionId: VersionId,
    content: PostContent,
  ): Promise<void> {
    const db = this.prisma.tx(market);
    const scope = { marketId: market.marketId, tenantId: market.tenantId, versionId };
    if (content.event !== null) {
      const event = content.event;
      await db.blogPostEvent.create({
        data: {
          ...scope,
          startsAt: toDate(event.startsAt),
          endsAt: toDate(event.endsAt),
          timeZone: event.timeZone,
          attendance: event.attendance,
          venueName: event.venueName,
          address: event.address,
          registrationUrl: event.registrationUrl,
          eventStatus: event.eventStatus,
          statusMessage: event.statusMessage,
        },
      });
    }
    if (content.links.length > 0) {
      await db.blogPostLink.createMany({
        data: content.links.map((link, position) => ({
          ...scope,
          targetType: link.type,
          targetRef: link.id,
          position,
        })),
      });
    }
    if (content.tagIds.length > 0) {
      await db.blogPostTag.createMany({
        data: content.tagIds.map((tagId) => ({ ...scope, tagId })),
      });
    }
  }

  async findVersion(
    market: MarketContext,
    postId: PostId,
    id: VersionId,
  ): Promise<VersionRecord | null> {
    const row = await this.prisma.tx(market).blogPostVersion.findFirst({
      where: { marketId: market.marketId, postId, id },
      include: FULL_VERSION,
    });
    return row === null ? null : toVersion(row);
  }

  async versionSummaries(
    market: MarketContext,
    postId: PostId,
  ): Promise<readonly VersionSummary[]> {
    const rows = await this.prisma.tx(market).blogPostVersion.findMany({
      where: { marketId: market.marketId, postId },
      select: {
        id: true,
        versionNo: true,
        state: true,
        createdAt: true,
        createdBy: true,
        editedByReviewer: true,
        submittedAt: true,
        decidedAt: true,
        decision: true,
        publishedAt: true,
      },
      orderBy: { versionNo: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id as VersionId,
      versionNo: row.versionNo,
      state: row.state as VersionState,
      createdAt: toInstant(row.createdAt),
      createdBy: row.createdBy as Id<'Account'>,
      editedByReviewer: row.editedByReviewer,
      submittedAt: toInstantOrNull(row.submittedAt),
      decidedAt: toInstantOrNull(row.decidedAt),
      decision: row.decision as VersionRecord['decision'],
      publishedAt: toInstantOrNull(row.publishedAt),
    }));
  }

  async lastVersionNo(market: MarketContext, postId: PostId): Promise<number> {
    const row = await this.prisma.tx(market).blogPostVersion.findFirst({
      where: { marketId: market.marketId, postId },
      select: { versionNo: true },
      orderBy: { versionNo: 'desc' },
    });
    return row?.versionNo ?? 0;
  }

  async updateVersion(
    market: MarketContext,
    postId: PostId,
    id: VersionId,
    change: VersionChange,
    at: Temporal.Instant,
  ): Promise<void> {
    const data: Record<string, unknown> = { updatedAt: toDate(at) };
    if (change.state !== undefined) data.state = change.state;
    if (change.submittedAt !== undefined) data.submittedAt = dateOrNull(change.submittedAt);
    if (change.submittedBy !== undefined) data.submittedBy = change.submittedBy;
    if (change.decidedAt !== undefined) data.decidedAt = dateOrNull(change.decidedAt);
    if (change.decidedBy !== undefined) data.decidedBy = change.decidedBy;
    if (change.decision !== undefined) data.decision = change.decision;
    if (change.decisionNote !== undefined) data.decisionNote = change.decisionNote;
    if (change.selfApproved !== undefined) data.selfApproved = change.selfApproved;
    if (change.publishedAt !== undefined) data.publishedAt = dateOrNull(change.publishedAt);
    if (change.publishedBy !== undefined) data.publishedBy = change.publishedBy;
    await this.prisma.tx(market).blogPostVersion.updateMany({
      where: { marketId: market.marketId, postId, id },
      data,
    });
  }

  async replaceContent(
    market: MarketContext,
    postId: PostId,
    id: VersionId,
    content: PostContent,
    at: Temporal.Instant,
  ): Promise<void> {
    const db = this.prisma.tx(market);
    const where = { marketId: market.marketId, versionId: id };
    await db.blogPostEvent.deleteMany({ where });
    await db.blogPostLink.deleteMany({ where });
    await db.blogPostTag.deleteMany({ where });
    await db.blogPostVersion.updateMany({
      where: { marketId: market.marketId, postId, id },
      data: {
        title: content.title,
        excerpt: content.excerpt,
        body: content.body as unknown as object[],
        coverImageId: content.coverImageId,
        coverAlt: content.coverAlt,
        seoTitle: content.seoTitle,
        seoDescription: content.seoDescription,
        authorDisplay: content.authorDisplay,
        categoryId: content.categoryId,
        updatedAt: toDate(at),
      },
    });
    await this.writeChildren(market, id, content);
  }

  async setEventStatus(
    market: MarketContext,
    versionIds: readonly VersionId[],
    status: string,
    message: string | null,
  ): Promise<void> {
    if (versionIds.length === 0) return;
    await this.prisma.tx(market).blogPostEvent.updateMany({
      where: { marketId: market.marketId, versionId: { in: [...versionIds] } },
      data: { eventStatus: status, statusMessage: message },
    });
  }

  // ------------------------------------------------------------------------------ redirects

  async findRedirect(market: MarketContext, fromSlug: string): Promise<RedirectRecord | null> {
    const row = await this.prisma.tx(market).blogRedirect.findFirst({
      where: { marketId: market.marketId, fromSlug },
    });
    return row === null ? null : { fromSlug: row.fromSlug, postId: row.postId as PostId };
  }

  async insertRedirect(
    market: MarketContext,
    redirect: {
      readonly id: Id<'BlogRedirect'>;
      readonly fromSlug: string;
      readonly postId: PostId;
    },
    at: Temporal.Instant,
  ): Promise<void> {
    await this.prisma.tx(market).blogRedirect.create({
      data: {
        id: redirect.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        fromSlug: redirect.fromSlug,
        postId: redirect.postId,
        createdAt: toDate(at),
      },
    });
  }

  async deleteRedirect(market: MarketContext, fromSlug: string): Promise<void> {
    await this.prisma.tx(market).blogRedirect.deleteMany({
      where: { marketId: market.marketId, fromSlug },
    });
  }

  // ----------------------------------------------------------------------------------- quota

  async quotaUsed(market: MarketContext, sellerId: Id<'Seller'>, period: string): Promise<number> {
    const row = await this.prisma.tx(market).blogSellerQuota.findFirst({
      where: { marketId: market.marketId, sellerId, period },
      select: { used: true },
    });
    return row?.used ?? 0;
  }

  async consumeQuota(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    period: string,
    limit: number,
    at: Temporal.Instant,
  ): Promise<boolean> {
    if (limit < 1) return false;
    const db = this.prisma.tx(market);
    // The row is created empty if missing (ON CONFLICT DO NOTHING: a lost race is no error), then
    // one conditional update adds the unit; the row lock serialises two submits of one seller.
    await db.blogSellerQuota.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId,
          period,
          used: 0,
          updatedAt: toDate(at),
        },
      ],
      skipDuplicates: true,
    });
    const { count } = await db.blogSellerQuota.updateMany({
      where: { marketId: market.marketId, sellerId, period, used: { lt: limit } },
      data: { used: { increment: 1 }, updatedAt: toDate(at) },
    });
    return count === 1;
  }

  // -------------------------------------------------------------------------------- public

  async listPublished(
    market: MarketContext,
    filter: PublicFilter,
    page: { readonly limit: number; readonly offset: number },
  ): Promise<readonly PublicRow[]> {
    const rows = await this.prisma.tx(market).blogPost.findMany({
      where: {
        marketId: market.marketId,
        status: 'published',
        liveVersionId: { not: null },
        ...(filter.kind === undefined ? {} : { kind: filter.kind }),
        liveVersion: {
          is: {
            ...(filter.categoryId === undefined ? {} : { categoryId: filter.categoryId }),
            ...(filter.tagId === undefined ? {} : { tags: { some: { tagId: filter.tagId } } }),
          },
        },
      },
      include: { liveVersion: { omit: { body: true }, include: LIST_VERSION } },
      orderBy: [{ featured: 'desc' }, { publishedAt: 'desc' }, { id: 'desc' }],
      take: page.limit,
      skip: page.offset,
    });
    return rows.flatMap((row) =>
      row.liveVersion === null ? [] : [{ post: toPost(row), version: toVersion(row.liveVersion) }],
    );
  }

  async upcomingEvents(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly PublicRow[]> {
    const rows = await this.prisma.tx(market).blogPost.findMany({
      where: {
        marketId: market.marketId,
        status: 'published',
        kind: 'event',
        liveVersion: { is: { event: { is: { endsAt: { gt: toDate(now) } } } } },
      },
      include: { liveVersion: { omit: { body: true }, include: LIST_VERSION } },
      orderBy: { liveVersion: { event: { startsAt: 'asc' } } },
      take: limit,
    });
    return rows.flatMap((row) =>
      row.liveVersion === null ? [] : [{ post: toPost(row), version: toVersion(row.liveVersion) }],
    );
  }

  // ------------------------------------------------------------------------------- taxonomy

  private toCategory(row: {
    readonly id: string;
    readonly slug: string;
    readonly position: number;
    readonly names: readonly { readonly locale: string; readonly name: string }[];
  }): CategoryRecord {
    return {
      id: row.id as CategoryId,
      slug: row.slug,
      position: row.position,
      names: new Map(row.names.map((n) => [n.locale, n.name])),
    };
  }

  async listCategories(market: MarketContext): Promise<readonly CategoryRecord[]> {
    const rows = await this.prisma.tx(market).blogCategory.findMany({
      where: { marketId: market.marketId },
      include: { names: true },
      orderBy: [{ position: 'asc' }, { slug: 'asc' }],
    });
    return rows.map((row) => this.toCategory(row));
  }

  async findCategory(market: MarketContext, id: CategoryId): Promise<CategoryRecord | null> {
    const row = await this.prisma.tx(market).blogCategory.findFirst({
      where: { marketId: market.marketId, id },
      include: { names: true },
    });
    return row === null ? null : this.toCategory(row);
  }

  async findCategoryBySlug(market: MarketContext, slug: string): Promise<CategoryRecord | null> {
    const row = await this.prisma.tx(market).blogCategory.findFirst({
      where: { marketId: market.marketId, slug },
      include: { names: true },
    });
    return row === null ? null : this.toCategory(row);
  }

  async insertCategory(
    market: MarketContext,
    category: CategoryRecord,
    stamp: Stamp,
  ): Promise<void> {
    const db = this.prisma.tx(market);
    await db.blogCategory.create({
      data: {
        id: category.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        slug: category.slug,
        position: category.position,
        createdAt: toDate(stamp.at),
        createdBy: stamp.by,
        updatedAt: toDate(stamp.at),
        updatedBy: stamp.by,
      },
    });
    await this.writeNames(market, category.id, category.names);
  }

  private async writeNames(
    market: MarketContext,
    categoryId: CategoryId,
    names: ReadonlyMap<string, string>,
  ): Promise<void> {
    await this.prisma.tx(market).blogCategoryName.createMany({
      data: [...names].map(([locale, name]) => ({
        marketId: market.marketId,
        tenantId: market.tenantId,
        categoryId,
        locale,
        name,
      })),
    });
  }

  async updateCategory(
    market: MarketContext,
    id: CategoryId,
    change: { readonly position: number; readonly names: ReadonlyMap<string, string> },
    stamp: Stamp,
  ): Promise<void> {
    const db = this.prisma.tx(market);
    await db.blogCategory.updateMany({
      where: { marketId: market.marketId, id },
      data: { position: change.position, updatedAt: toDate(stamp.at), updatedBy: stamp.by },
    });
    await db.blogCategoryName.deleteMany({ where: { marketId: market.marketId, categoryId: id } });
    await this.writeNames(market, id, change.names);
  }

  async categoryInUse(market: MarketContext, id: CategoryId): Promise<boolean> {
    const row = await this.prisma.tx(market).blogPostVersion.findFirst({
      where: { marketId: market.marketId, categoryId: id },
      select: { id: true },
    });
    return row !== null;
  }

  async deleteCategory(market: MarketContext, id: CategoryId): Promise<void> {
    const db = this.prisma.tx(market);
    await db.blogCategoryName.deleteMany({ where: { marketId: market.marketId, categoryId: id } });
    await db.blogCategory.deleteMany({ where: { marketId: market.marketId, id } });
  }

  async listTags(market: MarketContext): Promise<readonly TagRecord[]> {
    const rows = await this.prisma.tx(market).blogTag.findMany({
      where: { marketId: market.marketId },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => ({ id: row.id as TagId, slug: row.slug, name: row.name }));
  }

  async findTags(market: MarketContext, ids: readonly TagId[]): Promise<readonly TagRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.tx(market).blogTag.findMany({
      where: { marketId: market.marketId, id: { in: [...ids] } },
    });
    return rows.map((row) => ({ id: row.id as TagId, slug: row.slug, name: row.name }));
  }

  async findTagBySlug(market: MarketContext, slug: string): Promise<TagRecord | null> {
    const row = await this.prisma.tx(market).blogTag.findFirst({
      where: { marketId: market.marketId, slug },
    });
    return row === null ? null : { id: row.id as TagId, slug: row.slug, name: row.name };
  }

  async insertTag(market: MarketContext, tag: TagRecord, stamp: Stamp): Promise<void> {
    await this.prisma.tx(market).blogTag.create({
      data: {
        id: tag.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        slug: tag.slug,
        name: tag.name,
        createdAt: toDate(stamp.at),
        createdBy: stamp.by,
      },
    });
  }

  async tagInUse(market: MarketContext, id: TagId): Promise<boolean> {
    const row = await this.prisma.tx(market).blogPostTag.findFirst({
      where: { marketId: market.marketId, tagId: id },
      select: { versionId: true },
    });
    return row !== null;
  }

  async deleteTag(market: MarketContext, id: TagId): Promise<void> {
    await this.prisma.tx(market).blogTag.deleteMany({ where: { marketId: market.marketId, id } });
  }
}
