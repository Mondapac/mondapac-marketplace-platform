// The Blog posts super list (list 26): the answer of GET blog/admin/posts (apps/api blog module,
// `admin-post-list-flow.ts`) and the list's own state.

import { isDatePreset, type DatePreset } from '../../sales/date-presets.ts';
import { OWNER_TYPES, POST_KINDS, POST_STATUSES, type OwnerType, type PostKind } from '../types.ts';

export const PAGE_SIZES = [25, 50, 100] as const;
/** Rows that can be ticked one by one for an export (the API takes up to 200 ids). */
export const SELECTION_MAX = 200;
/** The API stops page numbers at this row; deeper rows need a filter. */
export const MAX_PAGED_ROWS = 10_000;
/** The longest search the API takes (characters). */
export const SEARCH_MAX = 100;

/** The views (tabs): every post, then one per status. */
export const VIEWS = ['all', ...POST_STATUSES] as const;
export type View = (typeof VIEWS)[number];
export const isView = (value: unknown): value is View => VIEWS.some((view) => view === value);

export const SORTS = ['created', 'updated', 'published', 'scheduled'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';
/** The go-live time starts with the soonest; the others with the most recent. */
export const defaultDirection = (sort: Sort): Direction => (sort === 'scheduled' ? 'asc' : 'desc');

/**
 * The row actions the API names, in the order of the menu. Each opens a page of its own, so none
 * is a dialog here; an id this panel does not know is ignored.
 */
export const ROW_ACTIONS = [
  'open',
  'edit',
  'submit',
  'approve',
  'request-changes',
  'reviewer-edit',
  'publish',
  'schedule',
  'unschedule',
  'pause',
  'resume',
  'archive',
  'rename-slug',
  'feature',
] as const;
export type RowAction = (typeof ROW_ACTIONS)[number];

export interface PostListRow {
  readonly id: string;
  readonly kind: PostKind;
  readonly slug: string;
  readonly ownerType: OwnerType;
  readonly sellerId: string | null;
  /** One of {@link POST_STATUSES}; a status this panel does not know shows as plain text. */
  readonly status: string;
  /** The state of the version being worked on (draft, in_review, returned, approved), if any. */
  readonly openState: string | null;
  readonly title: string;
  readonly featured: boolean;
  readonly scheduledAt: string | null;
  readonly publishedAt: string | null;
  readonly updatedAt: string;
  readonly actions: readonly string[];
}

export type ViewCounts = Readonly<Record<View, number>>;

export interface PostListPage {
  readonly items: readonly PostListRow[];
  readonly counts: ViewCounts;
  /** Page numbers only; null with Previous and next. */
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number;
  readonly hasMore: boolean;
  /** Previous and next: the cursor of the next page, null on the last one. */
  readonly nextCursor: string | null;
}

export const FILTER_FIELDS = ['kind', 'owner', 'featured', 'updated'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

export const FEATURED_VALUES = ['yes', 'no'] as const;
export type FeaturedValue = (typeof FEATURED_VALUES)[number];

/** The conditions of the filter panel; each is one value. */
export interface Filters {
  readonly kind?: PostKind;
  readonly owner?: OwnerType;
  readonly featured?: FeaturedValue;
  readonly updated?: DatePreset;
}

export const filterCount = (filters: Filters): number => Object.keys(filters).length;

const pick = <T extends string>(list: readonly T[], value: string | undefined): T | undefined =>
  list.find((entry) => entry === value);

/** The filters a panel answer holds: only a known value of a known field. */
export function filtersOf(values: Readonly<Record<string, string | undefined>>): Filters {
  const kind = pick(POST_KINDS, values['kind']);
  const owner = pick(OWNER_TYPES, values['owner']);
  const featured = pick(FEATURED_VALUES, values['featured']);
  const updated = values['updated'];
  return {
    ...(kind === undefined ? {} : { kind }),
    ...(owner === undefined ? {} : { owner }),
    ...(featured === undefined ? {} : { featured }),
    ...(isDatePreset(updated) ? { updated } : {}),
  };
}

export interface Query {
  readonly view: View;
  /** The search box as typed: part of a title or web address. */
  readonly q: string;
  readonly filters: Filters;
  readonly sort: Sort;
  readonly direction: Direction;
  /** Page numbers: the page from 1. */
  readonly page: number;
  readonly pageSize: number;
  /** Previous and next: the cursors that opened each page after the first. */
  readonly cursors: readonly string[];
}

export const DEFAULT_QUERY: Query = {
  view: 'all',
  q: '',
  filters: {},
  sort: 'created',
  direction: 'desc',
  page: 1,
  pageSize: PAGE_SIZES[0],
  cursors: [],
};
