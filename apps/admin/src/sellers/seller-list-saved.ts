// Saved filters of the Sellers list (list key `admin.sellers.list`, registered by the lists
// module): the closed document a saved filter keeps and the two conversions between it and the
// page's query. NOT wired into the page yet: the follow-up adds `useSavedFilters(LIST_KEY)` and the
// views bar `manage`, as the queue lists do. The search text is never saved.

import { stringsOf } from '../sales/sales-saved.ts';
import {
  DEFAULT_QUERY,
  SORTS,
  filtersFor,
  queueDirection,
  type Direction,
  type Filters,
  type Query,
  type Sort,
} from './seller-list-query.ts';
import { TABS, type Tab } from './types.ts';

export const LIST_KEY = 'admin.sellers.list';

/** The document a saved filter holds: keys the page did not change are left out. */
export interface SavedPayload {
  readonly v: 1;
  readonly view: Tab;
  readonly filters?: { kind?: string; outsideArea?: string; areaCode?: string };
  readonly sort?: Sort;
  readonly direction?: Direction;
}

/** Whether the page shows anything a saved filter could keep. */
export function somethingToSave(query: Query): boolean {
  return (
    query.view !== DEFAULT_QUERY.view ||
    Object.keys(filtersFor(query.view, query.filters)).length > 0 ||
    query.sort !== DEFAULT_QUERY.sort ||
    query.direction !== queueDirection(query.view)
  );
}

export function payloadOf(query: Query): SavedPayload {
  const filters = filtersFor(query.view, query.filters);
  return {
    v: 1,
    view: query.view,
    ...(Object.keys(filters).length === 0 ? {} : { filters }),
    ...(query.sort !== DEFAULT_QUERY.sort ? { sort: query.sort } : {}),
    ...(query.direction !== queueDirection(query.view) ? { direction: query.direction } : {}),
  };
}

/** The query a saved filter opens, on its first page; a value the page does not know is dropped. */
export function queryOf(payload: SavedPayload): Query {
  const view = TABS.find((value) => value === payload.view) ?? DEFAULT_QUERY.view;
  const strings = stringsOf(payload.filters);
  const filters: Filters = filtersFor(view, {
    ...(strings['kind'] === undefined ? {} : { kind: strings['kind'] }),
    ...(strings['outsideArea'] === 'true' ? { outsideArea: 'true' } : {}),
    ...(strings['areaCode'] === undefined ? {} : { areaCode: strings['areaCode'] }),
  });
  const sort = SORTS.find((value) => value === payload.sort) ?? DEFAULT_QUERY.sort;
  const direction: Direction =
    payload.direction === 'asc' || payload.direction === 'desc'
      ? payload.direction
      : sort === 'name'
        ? 'asc'
        : queueDirection(view);
  return { ...DEFAULT_QUERY, view, filters, sort, direction };
}
