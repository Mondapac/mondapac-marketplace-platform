// The saved filters of the seller Products list (catalog design 9.2d, catalog/seller/saved-filters):
// the document a saved filter keeps, and the two conversions between it and the page's own query.

import {
  DEFAULT_QUERY,
  FILTER_FIELDS,
  SORTS,
  STATUSES,
  VIEWS,
  defaultDirection,
  type Direction,
  type Filters,
  type Query,
  type Sort,
  type Status,
  type View,
} from './products-list-types.ts';

/** The list the seller Products page's saved filters belong to. */
export const LIST_KEY = 'seller.catalog.products';
/** The permission that lets a member share a filter with the whole store. */
export const SHARE_PERMISSION = 'catalog.own-saved-filter.share';
export const NAME_MAX = 60;
export const DEFAULT_LIMITS = { perOwner: 50, shared: 20 } as const;

export type Visibility = 'me' | 'everyone';

/** The flat document of a saved filter: the list's own selector, with a version. */
export interface SavedPayload {
  readonly v: 1;
  readonly view: View;
  readonly q?: string;
  readonly status?: Status;
  readonly categoryId?: string;
  readonly paused?: boolean;
  readonly typeCode?: string;
  readonly sort: Sort;
  readonly direction: Direction;
}

export interface SavedFilter {
  readonly id: string;
  readonly listKey: string;
  readonly name: string;
  readonly visibility: Visibility;
  readonly payload: SavedPayload;
  readonly ownedByMe: boolean;
  readonly canManage: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SavedFiltersAnswer {
  readonly items: readonly SavedFilter[];
  readonly canShare: boolean;
  readonly limits: { readonly perOwner: number; readonly shared: number };
}

/** The document that saves what the page shows now (the page and its size are not saved). */
export function payloadOf(query: Query): SavedPayload {
  const q = query.q.trim();
  const { status, categoryId, paused, typeCode } = query.filters;
  return {
    v: 1,
    view: query.view,
    ...(q === '' ? {} : { q }),
    ...(status === undefined ? {} : { status }),
    ...(categoryId === undefined ? {} : { categoryId }),
    ...(paused === undefined ? {} : { paused: paused === 'true' }),
    ...(typeCode === undefined ? {} : { typeCode }),
    sort: query.sort,
    direction: query.direction,
  };
}

const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined =>
  list.find((entry) => entry === value);

/**
 * The page query a saved filter opens, on its first page and the given page size. `v` is the
 * document's version and never reaches the address. A value the page does not know is dropped, so
 * the result is always one the list accepts.
 */
export function queryOf(payload: SavedPayload, pageSize: number): Query {
  const sort = oneOf(SORTS, payload.sort) ?? DEFAULT_QUERY.sort;
  const filters: Filters = {
    ...(oneOf(STATUSES, payload.status) === undefined ? {} : { status: payload.status }),
    ...(payload.categoryId === undefined ? {} : { categoryId: payload.categoryId }),
    ...(payload.paused === undefined ? {} : { paused: payload.paused ? 'true' : 'false' }),
    ...(payload.typeCode === undefined ? {} : { typeCode: payload.typeCode }),
  };
  return {
    view: oneOf(VIEWS, payload.view) ?? DEFAULT_QUERY.view,
    q: payload.q ?? '',
    filters,
    sort,
    direction: oneOf(['asc', 'desc'] as const, payload.direction) ?? defaultDirection(sort),
    page: 1,
    pageSize,
  };
}

/** Both queries show the same list: the tab, search, conditions and sort (not the page). */
export function sameList(a: Query, b: Query): boolean {
  return (
    a.view === b.view &&
    a.q === b.q &&
    a.sort === b.sort &&
    a.direction === b.direction &&
    FILTER_FIELDS.every((field) => a.filters[field] === b.filters[field])
  );
}

/** A tab on its own: no search, no condition and the default sort. Any other list can be saved. */
export const isPlainView = (query: Query): boolean =>
  query.q === '' &&
  FILTER_FIELDS.every((field) => query.filters[field] === undefined) &&
  query.sort === DEFAULT_QUERY.sort &&
  query.direction === DEFAULT_QUERY.direction;
