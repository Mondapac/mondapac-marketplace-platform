import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { AdminPostListReader } from '../../src/modules/blog/application/ports/admin-post-list.reader';
import type {
  BlogRepository,
  PostListRow,
} from '../../src/modules/blog/application/ports/blog.repository';
import type {
  PostListCursor,
  PostListFilter,
  PostSort,
  PostStatusCounts,
} from '../../src/modules/blog/domain/admin-post-list';
import { POST_STATUSES, type PostStatus } from '../../src/modules/blog/domain/lifecycle';

// In-memory stand-in for the admin Blog posts list (list 26), with the filter, sort and cursor of
// the Prisma reader, over the rows a BlogRepository lists (titles of the open or live version).

const ALL = 1_000_000;

function matches(row: PostListRow, filter: PostListFilter): boolean {
  const p = row.post;
  if (filter.status !== null && p.status !== filter.status) return false;
  if (filter.kind !== null && p.kind !== filter.kind) return false;
  if (filter.ownerType !== null && p.ownerType !== filter.ownerType) return false;
  if (filter.sellerId !== null && p.sellerId !== filter.sellerId) return false;
  if (filter.featured !== null && p.featured !== filter.featured) return false;
  if (filter.search !== null) {
    const needle = filter.search.toLowerCase();
    if (!p.slug.toLowerCase().includes(needle) && !row.title.toLowerCase().includes(needle)) {
      return false;
    }
  }
  if (filter.from !== null && Temporal.Instant.compare(p.updatedAt, filter.from) < 0) return false;
  if (filter.to !== null && Temporal.Instant.compare(p.updatedAt, filter.to) >= 0) return false;
  return true;
}

function compare(a: PostListRow, b: PostListRow, sort: PostSort): number {
  const sign = sort.direction === 'asc' ? 1 : -1;
  let order: number;
  switch (sort.key) {
    case 'published':
    case 'scheduled': {
      const field = sort.key === 'published' ? 'publishedAt' : 'scheduledAt';
      const x = a.post[field];
      const y = b.post[field];
      if ((x === null) !== (y === null)) return x === null ? 1 : -1;
      order = x === null || y === null ? 0 : Temporal.Instant.compare(x, y);
      break;
    }
    case 'updated':
      order = Temporal.Instant.compare(a.post.updatedAt, b.post.updatedAt);
      break;
    default:
      order = Temporal.Instant.compare(a.post.createdAt, b.post.createdAt);
  }
  if (order === 0) order = a.post.id < b.post.id ? -1 : a.post.id > b.post.id ? 1 : 0;
  return order * sign;
}

export class MemoryAdminPostList implements AdminPostListReader {
  /** Every read, so a test can see that nothing was read before a refusal. */
  reads = 0;

  constructor(private readonly posts: BlogRepository) {}

  async #rows(market: MarketContext): Promise<PostListRow[]> {
    this.reads += 1;
    return [...(await this.posts.listPosts(market, {}, { limit: ALL, offset: 0 }))];
  }

  async page(
    market: MarketContext,
    filter: PostListFilter,
    sort: PostSort,
    offset: number,
    limit: number,
    after: PostListCursor | null = null,
  ) {
    const rows = (await this.#rows(market))
      .filter((r) => matches(r, filter))
      .filter((r) => {
        if (after === null) return true;
        const c = Temporal.Instant.compare(r.post.createdAt, after.createdAt);
        return c < 0 || (c === 0 && r.post.id < after.id);
      })
      .sort((a, b) => compare(a, b, sort));
    return rows.slice(offset, offset + limit);
  }

  async idsPage(market: MarketContext, filter: PostListFilter, sort: PostSort, limit: number) {
    return (await this.page(market, filter, sort, 0, limit)).map((r) => r.post.id);
  }

  async count(market: MarketContext, filter: PostListFilter) {
    return (await this.#rows(market)).filter((r) => matches(r, filter)).length;
  }

  async countByStatus(market: MarketContext): Promise<PostStatusCounts> {
    const counts = Object.fromEntries(POST_STATUSES.map((s) => [s, 0])) as Record<
      PostStatus,
      number
    >;
    for (const r of await this.#rows(market)) counts[r.post.status] += 1;
    return counts;
  }

  async byIds(market: MarketContext, ids: readonly Id<'BlogPost'>[]) {
    return (await this.#rows(market)).filter((r) => ids.includes(r.post.id));
  }
}
