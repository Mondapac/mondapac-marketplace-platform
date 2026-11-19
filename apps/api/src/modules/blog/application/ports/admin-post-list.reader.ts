import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  PostListCursor,
  PostListFilter,
  PostSort,
  PostStatusCounts,
} from '../../domain/admin-post-list';
import type { PostListRow } from './blog.repository';

export const ADMIN_POST_LIST_READER = Symbol('ADMIN_POST_LIST_READER');

/**
 * The reads of the admin Blog posts list (list 26) and its export, each inside a read-only unit
 * of the caller's Market: never a row of another Market.
 */
export interface AdminPostListReader {
  /** One page in `sort`; with `after`, newest created first after that key (Previous/Next). */
  page(
    market: MarketContext,
    filter: PostListFilter,
    sort: PostSort,
    offset: number,
    limit: number,
    after?: PostListCursor | null,
  ): Promise<readonly PostListRow[]>;
  /** The ids of the matching posts in `sort`, at most `limit` (the export fixes them first). */
  idsPage(
    market: MarketContext,
    filter: PostListFilter,
    sort: PostSort,
    limit: number,
  ): Promise<readonly Id<'BlogPost'>[]>;
  count(market: MarketContext, filter: PostListFilter): Promise<number>;
  /** The posts of the Market by status, from one grouped statement. */
  countByStatus(market: MarketContext): Promise<PostStatusCounts>;
  /** The named posts of the Market, in any order; an id of another Market is left out. */
  byIds(market: MarketContext, ids: readonly Id<'BlogPost'>[]): Promise<readonly PostListRow[]>;
}
