// The seller review list's query: what the tab, search, filters, sort and page ask
// GET reviews/seller/list for. The list always sends `page` and `paging` (the Market's List paging
// setting). The same selector (without the page) goes to the export.

export type ListPaging = 'pages' | 'prev-next';

export const VIEWS = ['all', 'unanswered', 'answered', 'low'] as const;
export type View = (typeof VIEWS)[number];

export const PAGE_SIZES = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;
/** The API stops page numbers here (a row past it needs a narrower list). */
export const MAX_PAGED_ROWS = 10_000;
/** The reviews that can be ticked one by one: what one export takes. */
export const SELECTION_MAX = 200;
export const SEARCH_MAX = 100;

export const SORT_FIELDS = ['published', 'rating'] as const;
export type SortField = (typeof SORT_FIELDS)[number];
export type Direction = 'asc' | 'desc';

/** Both sorts start with the biggest first: the newest, the most stars. */
export const defaultDirection = (): Direction => 'desc';

export const REPLY_FILTERS = ['none', 'published'] as const;
export type ReplyFilter = (typeof REPLY_FILTERS)[number];
export const RATINGS = ['1', '2', '3', '4', '5'] as const;
export type RatingFilter = (typeof RATINGS)[number];
/** "Published in the last N days"; the list turns it into a `from` instant when it asks. */
export const PUBLISHED_WITHIN = ['7', '30', '90'] as const;
export type PublishedWithin = (typeof PUBLISHED_WITHIN)[number];

/** The conditions of the filter panel; each is one value. */
export interface Filters {
  readonly reply?: ReplyFilter;
  readonly minRating?: RatingFilter;
  readonly maxRating?: RatingFilter;
  readonly within?: PublishedWithin;
}

export const FILTER_FIELDS = ['reply', 'minRating', 'maxRating', 'within'] as const;

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
  sort: 'published',
  direction: 'desc',
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

export const filterCount = (query: Query): number => Object.keys(query.filters).length;

const oneOf = <T extends string>(list: readonly T[], value: string | undefined): T | undefined =>
  list.find((entry) => entry === value);

/** The filters a panel answer holds: only a known value of a known field. */
export function filtersOf(values: Readonly<Record<string, string>>): Filters {
  const reply = oneOf(REPLY_FILTERS, values['reply']);
  const minRating = oneOf(RATINGS, values['minRating']);
  const maxRating = oneOf(RATINGS, values['maxRating']);
  const within = oneOf(PUBLISHED_WITHIN, values['within']);
  return {
    ...(reply === undefined ? {} : { reply }),
    ...(minRating === undefined ? {} : { minRating }),
    ...(maxRating === undefined ? {} : { maxRating }),
    ...(within === undefined ? {} : { within }),
  };
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * The selector both the list and the export send: tab, search, filters and sort. `now` is passed
 * so a test can fix the clock; "last N days" becomes a `from` instant.
 */
export function selectorParams(query: Query, now: number = Date.now()): URLSearchParams {
  const params = new URLSearchParams();
  params.set('view', query.tab);
  const text = query.q.trim();
  if (text !== '') params.set('q', text);
  const { reply, minRating, maxRating, within } = query.filters;
  if (reply !== undefined) params.set('reply', reply);
  if (minRating !== undefined) params.set('minRating', minRating);
  if (maxRating !== undefined) params.set('maxRating', maxRating);
  if (within !== undefined) {
    params.set('from', new Date(now - Number(within) * DAY_MS).toISOString());
  }
  params.set('sort', query.sort);
  params.set('direction', query.direction);
  return params;
}

export function queryString(query: Query, paging: ListPaging, now?: number): string {
  const params = selectorParams(query, now);
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  params.set('paging', paging);
  return params.toString();
}

/** The path of the first page the server reads for the list: every review, newest first. */
export const firstPagePath = (paging: ListPaging): string =>
  `reviews/seller/list?${queryString(DEFAULT_QUERY, paging)}`;
