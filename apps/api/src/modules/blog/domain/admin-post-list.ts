import type { Id, Temporal } from '@mondapac/shared-kernel';
import type { OwnerType, PostKind } from './content';
import { POST_STATUSES, type PostAction, type PostStatus } from './lifecycle';

// The admin Blog posts list (super list phase 4, list 26): views by status, the filters, the sort,
// the per-view counts, the row Actions menu and the export. It only reads; every action runs
// through its own use case, which checks its key, the lifecycle and the two-step rules again.

export const POST_LIST_VIEWS = [...POST_STATUSES, 'all'] as const;
export type PostListView = (typeof POST_LIST_VIEWS)[number];

export const POST_SORT_KEYS = ['created', 'updated', 'published', 'scheduled'] as const;
export type PostSortKey = (typeof POST_SORT_KEYS)[number];

export interface PostSort {
  readonly key: PostSortKey;
  readonly direction: 'asc' | 'desc';
}

/** The keyset of Previous/Next: newest created first, the id breaking ties. */
export interface PostListCursor {
  readonly createdAt: Temporal.Instant;
  readonly id: Id<'BlogPost'>;
}

export interface PostListFilter {
  /** Null for every status (the `all` view). */
  readonly status: PostStatus | null;
  readonly kind: PostKind | null;
  readonly ownerType: OwnerType | null;
  readonly sellerId: Id<'Seller'> | null;
  readonly featured: boolean | null;
  /** Part of the title (open or live version) or of the slug, any case; at most 100 characters. */
  readonly search: string | null;
  /** The last change: at or after `from`, before `to`. */
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant | null;
}

/** A row's Actions menu: open always; the others where the lifecycle and the caller's keys allow. */
export type PostRowAction = 'open' | PostAction;

export type PostStatusCounts = Readonly<Record<PostStatus, number>>;

export function postViewCounts(counts: PostStatusCounts): Readonly<Record<PostListView, number>> {
  const all = POST_STATUSES.reduce((sum, status) => sum + counts[status], 0);
  return { ...counts, all };
}

/** The columns an export may add, in the order the panel's column picker lists them. */
export const POST_EXPORT_COLUMNS = [
  'slug',
  'seller-id',
  'stage',
  'featured',
  'scheduled',
  'published',
  'created',
] as const;
export type PostExportColumn = (typeof POST_EXPORT_COLUMNS)[number];

/** The longest search the list takes. */
export const POST_SEARCH_MAX = 100;
