// The seller Offer list's query: what the tab, search, filters, sort and page ask
// GET catalog/seller/offers for (its list mode). The list always sends `page`, which selects the
// list mode, and `paging` from the Market's List paging setting.

export type ListPaging = 'pages' | 'prev-next';

export const VIEWS = ['all', 'drafts', 'in-review', 'changes-needed', 'live'] as const;
export type View = (typeof VIEWS)[number];

/** The statuses an Offer in the list can have (the API's `status` filter). */
export const STATUSES = ['draft', 'pending-first-publish', 'changes-needed', 'published'] as const;
export type StatusFilter = (typeof STATUSES)[number];

export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;
/** The API stops page numbers here (a row past it needs a narrower list). */
export const MAX_PAGED_ROWS = 10_000;
/** The Offers that can be ticked one by one: what one export takes. */
export const SELECTION_MAX = 100;
export const SEARCH_MAX = 100;

export const SORT_FIELDS = ['created', 'sku', 'status'] as const;
export type SortField = (typeof SORT_FIELDS)[number];
export type Direction = 'asc' | 'desc';

/** Created starts newest first; SKU and status start A to Z. */
export const defaultDirection = (field: SortField): Direction =>
  field === 'created' ? 'desc' : 'asc';

/** The conditions of the filter panel; each is one value. */
export interface Filters {
  readonly status?: StatusFilter;
  /** On sale: `true` or `false`. */
  readonly listed?: 'true' | 'false';
}

export const FILTER_FIELDS = ['status', 'listed'] as const;

export interface Query {
  readonly tab: View;
  readonly q: string;
  readonly filters: Filters;
  readonly sort: SortField;
  readonly direction: Direction;
  readonly page: number;
  readonly pageSize: number;
}

export const DEFAULT_QUERY: Query = {
  tab: 'all',
  q: '',
  filters: {},
  sort: 'created',
  direction: 'desc',
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

export const filterCount = (query: Query): number => Object.keys(query.filters).length;

const isStatus = (value: string | undefined): value is StatusFilter =>
  STATUSES.some((status) => status === value);

/** The filters a panel answer holds: only a known value of a known field. */
export function filtersOf(values: Readonly<Record<string, string>>): Filters {
  const status = values['status'];
  const listed = values['listed'];
  return {
    ...(isStatus(status) ? { status } : {}),
    ...(listed === 'true' || listed === 'false' ? { listed } : {}),
  };
}

/** The selector both the list and the export send: tab, search, filters and sort. */
export function selectorParams(query: Query): URLSearchParams {
  const params = new URLSearchParams();
  params.set('view', query.tab);
  const text = query.q.trim();
  if (text !== '') params.set('q', text);
  if (query.filters.status !== undefined) params.set('status', query.filters.status);
  if (query.filters.listed !== undefined) params.set('listed', query.filters.listed);
  params.set('sort', query.sort);
  params.set('direction', query.direction);
  return params;
}

export function queryString(query: Query, paging: ListPaging): string {
  const params = selectorParams(query);
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  params.set('paging', paging);
  return params.toString();
}

/** The path of the first page the server reads for the list: every Offer, newest first. */
export const firstPagePath = (paging: ListPaging): string =>
  `catalog/seller/offers?${queryString(DEFAULT_QUERY, paging)}`;
