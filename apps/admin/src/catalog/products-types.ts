// The admin product list (catalog design 9.2b, GET catalog/admin/products): the answer, the query
// and the per-viewer column choice. Ids, codes and names only; the API sends no price and no stock.

export const VIEW_PERMISSION = 'catalog.product.view';

export const VIEWS = ['active', 'all', 'inactive'] as const;
export type View = (typeof VIEWS)[number];

/**
 * The statuses a listed product can have (never `draft` or `discarded`). `paused` is a published
 * product an admin paused (catalog design 4.1a): the Inactive tab holds it.
 */
export const STATUSES = [
  'published',
  'paused',
  'unpublished',
  'withdrawn',
  'retired',
  'matched',
] as const;
export type Status = (typeof STATUSES)[number];

export const SCOPES = ['PLATFORM', 'SELLER'] as const;
export type Scope = (typeof SCOPES)[number];

export const SORTS = ['name', 'updated', 'created'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';

export const PAGE_SIZE = 25;
export const SEARCH_MAX = 100;

export interface ProductRow {
  readonly productId: string;
  readonly productCode: string;
  readonly name: string | null;
  readonly primaryImageId: string | null;
  readonly scope: Scope;
  readonly ownerSellerId: string | null;
  readonly ownerStoreName: string | null;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly typeCode: string;
  readonly status: Status;
  readonly offerCount: number;
  readonly updatedAt: string;
  readonly createdAt: string;
}

export interface ViewCounts {
  readonly active: number;
  readonly all: number;
  readonly inactive: number;
}

export interface ProductsPage {
  readonly items: readonly ProductRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly counts: ViewCounts;
}

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
  readonly scope?: Scope;
  readonly categoryId?: string;
}
export const FILTER_FIELDS = ['status', 'scope', 'categoryId'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

export interface Query {
  readonly view: View;
  readonly q: string;
  readonly filters: Filters;
  readonly sort: Sort;
  readonly direction: Direction;
  readonly page: number;
}

export const DEFAULT_QUERY: Query = {
  view: 'active',
  q: '',
  filters: {},
  sort: 'updated',
  direction: 'desc',
  page: 1,
};

/** The natural first direction of a sort: names read A to Z, dates newest first. */
export const defaultDirection = (sort: Sort): Direction => (sort === 'name' ? 'asc' : 'desc');

/** The message key of a direction: `name.first` is A to Z, `date.first` newest first. */
export const orderKey = (sort: Sort, direction: Direction): string =>
  `${sort === 'name' ? 'name' : 'date'}.${direction === defaultDirection(sort) ? 'first' : 'second'}`;

export function queryString(query: Query): string {
  const params = new URLSearchParams({
    view: query.view,
    sort: query.sort,
    direction: query.direction,
    page: String(query.page),
    pageSize: String(PAGE_SIZE),
  });
  if (query.q.trim() !== '') params.set('q', query.q.trim());
  for (const field of FILTER_FIELDS) {
    const value = query.filters[field];
    if (value !== undefined) params.set(field, value);
  }
  return params.toString();
}

/** The keys that gate the Bulk action menu (catalog design 8.1); Export needs only the view key. */
export const PAUSE_PERMISSION = 'catalog.product.pause';
export const DELETE_PERMISSION = 'catalog.product.delete';
export const RETIRE_PERMISSION = 'catalog.platform-product.retire';

/** The most products one request names by id; more is chosen with "Select all in this filter". */
export const BULK_MAX_IDS = 200;

export function filterCount(filters: Filters): number {
  return FILTER_FIELDS.filter((field) => filters[field] !== undefined).length;
}

/** The columns after the four that are always shown (image, title, status, category). */
export const OPTIONAL_COLUMNS = [
  'code',
  'offers',
  'updated',
  'type',
  'scope',
  'seller',
  'created',
] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

export const isOptionalColumn = (value: unknown): value is OptionalColumn =>
  typeof value === 'string' && (OPTIONAL_COLUMNS as readonly string[]).includes(value);

/** The saved columns, in order: unknown and repeated ids are dropped. */
export function cleanColumns(saved: readonly unknown[] | undefined): readonly OptionalColumn[] {
  const seen = new Set<OptionalColumn>();
  for (const id of saved ?? []) if (isOptionalColumn(id)) seen.add(id);
  return [...seen];
}

/** Nothing extra by default: image, title, status and main category (owner, design round 1). */
export const DEFAULT_COLUMNS: readonly OptionalColumn[] = [];
