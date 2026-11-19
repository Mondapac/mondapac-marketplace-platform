// The query of the Sellers super list (list 15): the page's own state, and the two requests it
// makes. Both routes are POST with a closed JSON body (a search term never sits in a URL); the
// API validates.

import { cleanColumnIds } from '../sales/columns.ts';
import { isStateTab, type Tab } from './types.ts';

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 100;
export const PAGE_SIZES = [25, 50, 100] as const;
/** The export takes at most this many ticked ids. */
export const SELECT_MAX = 200;
/** The API stops page numbers at this row (an identity state tab stops sooner). */
export const MAX_PAGED_ROWS = 10_000;

export const FILTER_FIELDS = ['kind', 'outsideArea', 'areaCode'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];
/** A filter that is not set is left out; `outsideArea` is "true" when set. */
export type Filters = Partial<Record<FilterField, string>>;

export const SORTS = ['queue', 'name'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';

export interface Query {
  readonly view: Tab;
  readonly q: string;
  readonly filters: Filters;
  readonly sort: Sort;
  readonly direction: Direction;
  readonly page: number;
  readonly pageSize: number;
}

/** The direction of a tab's own order: awaiting review oldest first, the rest newest first. */
export const queueDirection = (view: Tab): Direction =>
  view === 'awaiting-review' ? 'asc' : 'desc';

/** The direction a sort starts in on a view. */
export const defaultDirection = (sort: Sort, view: Tab): Direction =>
  sort === 'name' ? 'asc' : queueDirection(view);

export const DEFAULT_QUERY: Query = {
  view: 'all',
  q: '',
  filters: {},
  sort: 'queue',
  direction: 'desc',
  page: 1,
  pageSize: PAGE_SIZES[0],
};

/** A search shorter than the API takes is not sent (the box says why). */
export const searchOf = (q: string): string | undefined => {
  const text = q.trim();
  return text.length >= SEARCH_MIN ? text : undefined;
};

/** The filters a view takes: kind on awaiting review, outside-area on incomplete, area on files. */
export function filtersFor(view: Tab, filters: Filters): Filters {
  if (isStateTab(view)) return {};
  return {
    ...(view === 'awaiting-review' && filters.kind !== undefined ? { kind: filters.kind } : {}),
    ...(view === 'incomplete' && filters.outsideArea !== undefined
      ? { outsideArea: filters.outsideArea }
      : {}),
    ...(filters.areaCode !== undefined ? { areaCode: filters.areaCode } : {}),
  };
}

export const filterCount = (filters: Filters): number =>
  FILTER_FIELDS.filter((field) => filters[field] !== undefined).length;

/** A built-in tab opened from a saved tab: the list's defaults, on that tab. */
export const forView = (view: string): Query => ({
  ...DEFAULT_QUERY,
  view: view as Tab,
  direction: queueDirection(view as Tab),
});

/**
 * Another built-in tab with what still applies kept: a state tab takes no search, filter or name
 * sort and is newest first only; a file tab keeps the search, the area and a name sort.
 */
export function withView(current: Query, view: string): Query {
  const next = view as Tab;
  if (isStateTab(next)) {
    return { ...current, view: next, q: '', filters: {}, sort: 'queue', direction: 'desc' };
  }
  return {
    ...current,
    view: next,
    filters: filtersFor(next, current.filters),
    direction: current.sort === 'name' ? current.direction : queueDirection(next),
  };
}

/** A state tab has no search; one character keeps the search the query had (the box says why). */
export const withSearch = (current: Query, q: string): Query =>
  isStateTab(current.view) || (q !== '' && searchOf(q) === undefined) ? current : { ...current, q };

export const searchText = (current: Query): string => current.q;

/** The selector keys of the list and of an export. */
export function selectorBody(query: Query): Record<string, unknown> {
  const filters = filtersFor(query.view, query.filters);
  const q = isStateTab(query.view) ? undefined : searchOf(query.q);
  return {
    view: query.view,
    ...(filters.kind === undefined ? {} : { kind: filters.kind }),
    ...(filters.outsideArea === undefined ? {} : { outsideArea: filters.outsideArea === 'true' }),
    ...(filters.areaCode === undefined ? {} : { areaCode: filters.areaCode }),
    ...(q === undefined ? {} : { q }),
    sort: query.sort,
    direction: query.direction,
  };
}

/** The list request: the selector, the sort, the Market's paging mode and the page. */
export function listBody(query: Query, paging: 'pages' | 'prev-next'): Record<string, unknown> {
  return { ...selectorBody(query), paging, page: query.page, pageSize: query.pageSize };
}

/** The columns an admin can hide, show and reorder; the store is always shown. */
export const OPTIONAL_COLUMNS = [
  'owner',
  'status',
  'health',
  'area',
  'submitted',
  'changed',
  'seller-id',
] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];
export const DEFAULT_COLUMNS: readonly OptionalColumn[] = [
  'owner',
  'status',
  'health',
  'area',
  'submitted',
  'changed',
];

export const cleanColumns = (saved: readonly unknown[] | undefined): readonly OptionalColumn[] =>
  cleanColumnIds(saved, OPTIONAL_COLUMNS, DEFAULT_COLUMNS);

/** The optional columns of an export, as the API names them: it takes only the seller id. */
export const exportColumns = (columns: readonly OptionalColumn[]): string =>
  columns.includes('seller-id') ? 'seller-id' : '';
