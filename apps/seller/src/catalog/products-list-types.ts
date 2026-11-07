// The seller product list (catalog design 9.2a, GET catalog/seller/products in list mode): the
// answer, the query that the address keeps, and the per-viewer column choice. Ids, codes and names
// only; the API sends no price and no stock.

export const VIEWS = ['all', 'drafts', 'live', 'inactive', 'in-review'] as const;
export type View = (typeof VIEWS)[number];

/** The statuses the seller reader returns (discarded and withdrawn products are not listed). */
export const STATUSES = ['draft', 'unpublished', 'published', 'matched', 'retired'] as const;
export type Status = (typeof STATUSES)[number];

export const SORTS = ['name', 'updated', 'created'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';

export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;
/** The rows past which the API refuses a page (it answers validation.failed on `page`). */
export const MAX_LIST_ROWS = 10_000;
export const SEARCH_MAX = 100;

export interface ProductRow {
  readonly productId: string;
  readonly productCode: string;
  readonly typeCode: string;
  readonly status: string;
  readonly name: string | null;
  readonly draftName: string | null;
  readonly primaryImageId: string | null;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly offerCount: number;
  readonly pausedAt: string | null;
  readonly hasPendingRevision: boolean;
  readonly lastChangedAt: string;
  readonly createdAt: string;
}

export interface ViewCounts {
  readonly all: number;
  readonly drafts: number;
  readonly live: number;
  readonly inactive: number;
  readonly inReview: number;
}

export interface ProductsPage {
  readonly items: readonly ProductRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly counts: ViewCounts;
}

/** The count of a tab: `in-review` is `inReview` in the answer. */
export const countOf = (counts: ViewCounts, view: View): number =>
  view === 'in-review' ? counts.inReview : counts[view];

/** The categories of GET catalog/categories (public tree, depth first). */
export interface CategoryTree {
  readonly categories: readonly {
    readonly id: string;
    readonly name: string;
    readonly depth: number;
  }[];
}

/** The conditions of the filter panel: each field is set at most once ("match all"). */
export interface Filters {
  readonly status?: Status;
  readonly categoryId?: string;
  readonly paused?: 'true' | 'false';
  readonly typeCode?: string;
}
export const FILTER_FIELDS = ['status', 'categoryId', 'paused', 'typeCode'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

export interface Query {
  readonly view: View;
  readonly q: string;
  readonly filters: Filters;
  readonly sort: Sort;
  readonly direction: Direction;
  readonly page: number;
  readonly pageSize: number;
}

export const DEFAULT_QUERY: Query = {
  view: 'all',
  q: '',
  filters: {},
  sort: 'updated',
  direction: 'desc',
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

/** The natural first direction of a sort: names read A to Z, dates newest first. */
export const defaultDirection = (sort: Sort): Direction => (sort === 'name' ? 'asc' : 'desc');

/** The message key of a direction: `name.first` is A to Z, `date.first` newest first. */
export const orderKey = (sort: Sort, direction: Direction): string =>
  `${sort === 'name' ? 'name' : 'date'}.${direction === defaultDirection(sort) ? 'first' : 'second'}`;

export function filterCount(filters: Filters): number {
  return FILTER_FIELDS.filter((field) => filters[field] !== undefined).length;
}

/** A search or a filter is set: the list is narrower than the whole store. */
export const isFiltered = (query: Query): boolean =>
  query.q !== '' || filterCount(query.filters) > 0;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

const oneOf = <T extends string>(list: readonly T[], value: string | null): T | undefined =>
  list.find((entry) => entry === value);

/**
 * The query an address carries. Anything unknown or malformed is dropped (a shared link never
 * breaks the page), so the result is always one the API accepts.
 */
export function parseQuery(params: { get(name: string): string | null }): Query {
  const sort = oneOf(SORTS, params.get('sort')) ?? DEFAULT_QUERY.sort;
  const direction =
    oneOf(['asc', 'desc'] as const, params.get('direction')) ?? defaultDirection(sort);
  const page = Number(params.get('page'));
  const pageSize = Number(params.get('pageSize'));
  const status = oneOf(STATUSES, params.get('status'));
  const categoryId = params.get('categoryId');
  const paused = oneOf(['true', 'false'] as const, params.get('paused'));
  const typeCode = params.get('typeCode');
  return {
    view: oneOf(VIEWS, params.get('view')) ?? 'all',
    q: (params.get('q') ?? '').trim().slice(0, SEARCH_MAX),
    filters: {
      ...(status === undefined ? {} : { status }),
      ...(categoryId !== null && UUID.test(categoryId) ? { categoryId } : {}),
      ...(paused === undefined ? {} : { paused }),
      ...(typeCode !== null && TYPE_CODE.test(typeCode) ? { typeCode } : {}),
    },
    sort,
    direction,
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    pageSize: (PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : DEFAULT_PAGE_SIZE,
  };
}

/** The address query of a list: only what differs from the defaults, so a link stays short. */
export function addressOf(query: Query): string {
  const params = new URLSearchParams();
  if (query.view !== DEFAULT_QUERY.view) params.set('view', query.view);
  if (query.q !== '') params.set('q', query.q);
  for (const field of FILTER_FIELDS) {
    const value = query.filters[field];
    if (value !== undefined) params.set(field, value);
  }
  if (query.sort !== DEFAULT_QUERY.sort) params.set('sort', query.sort);
  if (query.direction !== defaultDirection(query.sort)) params.set('direction', query.direction);
  if (query.page > 1) params.set('page', String(query.page));
  if (query.pageSize !== DEFAULT_PAGE_SIZE) params.set('pageSize', String(query.pageSize));
  return params.toString();
}

/** What the API takes in list mode: everything is sent, and the first page is `page=1`. */
export function queryString(query: Query): string {
  const params = new URLSearchParams({
    view: query.view,
    sort: query.sort,
    direction: query.direction,
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  if (query.q !== '') params.set('q', query.q);
  for (const field of FILTER_FIELDS) {
    const value = query.filters[field];
    if (value !== undefined) params.set(field, value);
  }
  return params.toString();
}

/** The last page that can be reached: the API stops at row 10,000. */
export const lastPage = (total: number, pageSize: number): number =>
  Math.max(1, Math.ceil(Math.min(total, MAX_LIST_ROWS) / pageSize));

/** The columns after the always-shown product, status and category. */
export const OPTIONAL_COLUMNS = ['code', 'updated', 'created', 'offers', 'type'] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

export const isOptionalColumn = (value: unknown): value is OptionalColumn =>
  typeof value === 'string' && (OPTIONAL_COLUMNS as readonly string[]).includes(value);

/** Product code and Last changed on; Created, Offers and Product type off (plan 6, F1). */
export const DEFAULT_COLUMNS: readonly OptionalColumn[] = ['code', 'updated'];

/**
 * The saved columns, in order: unknown and repeated ids are dropped. Nothing saved (undefined) is
 * the default; a saved empty list is a choice of no optional column.
 */
export function cleanColumns(saved: readonly unknown[] | undefined): readonly OptionalColumn[] {
  if (saved === undefined) return DEFAULT_COLUMNS;
  const seen = new Set<OptionalColumn>();
  for (const id of saved) if (isOptionalColumn(id)) seen.add(id);
  return [...seen];
}

/** How the Market's "List paging" setting is shown: page numbers, or Previous and next only. */
export type ListPagingMode = 'pages' | 'prev-next';
