// The saved filters of the product list (catalog design 9.2d, catalog/admin/saved-filters): the
// document a saved view keeps, and the two conversions between it and the page's own query.

import {
  FILTER_FIELDS,
  type Direction,
  type Query,
  type Scope,
  type Sort,
  type Status,
  type View,
} from './products-types.ts';

/** The list the product page's saved views belong to. */
export const LIST_KEY = 'admin.catalog.products';
export const SHARE_PERMISSION = 'catalog.saved-filter.share';
export const NAME_MAX = 60;

export type Visibility = 'me' | 'everyone';

/** The closed document of a saved view; keys the page does not set are left out. */
export interface SavedPayload {
  readonly v: 1;
  readonly view: View;
  readonly q?: string;
  readonly filters: {
    readonly status?: Status;
    readonly scope?: Scope;
    readonly categoryId?: string;
  };
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
  /** Products the view matched when the list loaded; null when the API did not count it. */
  readonly count: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SavedFiltersAnswer {
  readonly items: readonly SavedFilter[];
  readonly canShare: boolean;
  readonly limits: { readonly perOwner: number; readonly shared: number };
}

/** The document that saves what the page shows now. */
export function payloadOf(query: Query): SavedPayload {
  const q = query.q.trim();
  return {
    v: 1,
    view: query.view,
    ...(q === '' ? {} : { q }),
    filters: Object.fromEntries(
      FILTER_FIELDS.flatMap((field) =>
        query.filters[field] === undefined ? [] : [[field, query.filters[field]]],
      ),
    ),
    sort: query.sort,
    direction: query.direction,
  };
}

/** The page query a saved view opens, on its first page. */
export function queryOf(payload: SavedPayload): Query {
  return {
    view: payload.view,
    q: payload.q ?? '',
    filters: { ...payload.filters },
    sort: payload.sort,
    direction: payload.direction,
    page: 1,
  };
}
