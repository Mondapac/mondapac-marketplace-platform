import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { escapeLikeTerm } from '../../../platform/text/like-escape';
import type { AdminPostListReader } from '../application/ports/admin-post-list.reader';
import type { PostListRow } from '../application/ports/blog.repository';
import {
  type PostListCursor,
  type PostListFilter,
  type PostSort,
  type PostStatusCounts,
} from '../domain/admin-post-list';
import { POST_STATUSES, type PostStatus, type VersionState } from '../domain/lifecycle';
import { toPost, type PostRow } from './prisma-blog.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/** The titles a row needs: of the open version and of the live one. Bodies are never read. */
const INCLUDE = {
  draftVersion: { select: { title: true, state: true } },
  liveVersion: { select: { title: true } },
} as const;

type Included = PostRow & {
  readonly draftVersion: { readonly title: string; readonly state: string } | null;
  readonly liveVersion: { readonly title: string } | null;
};

const toRow = (row: Included): PostListRow => ({
  post: toPost(row),
  title: row.draftVersion?.title ?? row.liveVersion?.title ?? '',
  openState: (row.draftVersion?.state ?? null) as VersionState | null,
});

/** The WHERE of a filter; every branch keeps the Market's own posts only. */
function where(market: MarketContext, filter: PostListFilter) {
  const and: object[] = [];
  if (filter.search !== null) {
    // `%` and `_` match themselves: the term is escaped for LIKE.
    const contains = { contains: escapeLikeTerm(filter.search), mode: 'insensitive' as const };
    and.push({
      OR: [
        { slug: contains },
        { draftVersion: { is: { title: contains } } },
        { liveVersion: { is: { title: contains } } },
      ],
    });
  }
  return {
    marketId: market.marketId,
    ...(filter.status === null ? {} : { status: filter.status }),
    ...(filter.kind === null ? {} : { kind: filter.kind }),
    ...(filter.ownerType === null ? {} : { ownerType: filter.ownerType }),
    ...(filter.sellerId === null ? {} : { sellerId: filter.sellerId }),
    ...(filter.featured === null ? {} : { featured: filter.featured }),
    ...(filter.from === null && filter.to === null
      ? {}
      : {
          updatedAt: {
            ...(filter.from === null ? {} : { gte: toDate(filter.from) }),
            ...(filter.to === null ? {} : { lt: toDate(filter.to) }),
          },
        }),
    AND: and,
  };
}

function orderBy(sort: PostSort) {
  const tie = { id: sort.direction };
  switch (sort.key) {
    case 'updated':
      return [{ updatedAt: sort.direction }, tie];
    case 'published':
      // Never published: last either way.
      return [{ publishedAt: { sort: sort.direction, nulls: 'last' as const } }, tie];
    case 'scheduled':
      // Not scheduled: last either way.
      return [{ scheduledAt: { sort: sort.direction, nulls: 'last' as const } }, tie];
    default:
      return [{ createdAt: sort.direction }, tie];
  }
}

/**
 * {@link AdminPostListReader} on `blog.posts`, scoped by `marketId` in every `where`. Read-only;
 * the default order (created, newest first) runs on the (market, status, created, id) index.
 */
export class PrismaAdminPostListReader implements AdminPostListReader {
  constructor(private readonly prisma: PrismaService) {}

  async page(
    market: MarketContext,
    filter: PostListFilter,
    sort: PostSort,
    offset: number,
    limit: number,
    after: PostListCursor | null = null,
  ) {
    const base = where(market, filter);
    const rows = await this.prisma.tx(market).blogPost.findMany({
      where:
        after === null
          ? base
          : {
              ...base,
              AND: [
                ...base.AND,
                // The plain bound lets the index start at the cursor; the OR keeps the tie order.
                { createdAt: { lte: toDate(after.createdAt) } },
                {
                  OR: [
                    { createdAt: { lt: toDate(after.createdAt) } },
                    { createdAt: toDate(after.createdAt), id: { lt: after.id } },
                  ],
                },
              ],
            },
      include: INCLUDE,
      orderBy: orderBy(sort),
      skip: offset,
      take: limit,
    });
    return rows.map((row) => toRow(row as unknown as Included));
  }

  async idsPage(market: MarketContext, filter: PostListFilter, sort: PostSort, limit: number) {
    const rows = await this.prisma.tx(market).blogPost.findMany({
      where: where(market, filter),
      orderBy: orderBy(sort),
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id as Id<'BlogPost'>);
  }

  count(market: MarketContext, filter: PostListFilter) {
    return this.prisma.tx(market).blogPost.count({ where: where(market, filter) });
  }

  async countByStatus(market: MarketContext): Promise<PostStatusCounts> {
    const groups = await this.prisma.tx(market).blogPost.groupBy({
      by: ['status'],
      where: { marketId: market.marketId },
      _count: { _all: true },
    });
    const counts = Object.fromEntries(POST_STATUSES.map((s) => [s, 0])) as Record<
      PostStatus,
      number
    >;
    for (const group of groups) {
      if ((POST_STATUSES as readonly string[]).includes(group.status)) {
        counts[group.status as PostStatus] = group._count._all;
      }
    }
    return counts;
  }

  async byIds(market: MarketContext, ids: readonly Id<'BlogPost'>[]) {
    if (ids.length === 0) return [];
    const rows = await this.prisma.tx(market).blogPost.findMany({
      where: { marketId: market.marketId, id: { in: [...ids] } },
      include: INCLUDE,
    });
    return rows.map((row) => toRow(row as unknown as Included));
  }
}
