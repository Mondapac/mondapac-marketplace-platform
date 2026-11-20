// Saved filters of the moderation list (list key `admin.reviews.moderation`, generic routes of the
// lists module): the closed document a saved filter keeps, and the two conversions between it and
// the page's own query. The search text and the seller link are never saved.

import { stringsOf, type SavedFilter, type SavedFiltersAnswer } from '../../sales/sales-saved.ts';
import {
  DEFAULT_QUERY,
  SORTS,
  VIEWS,
  filtersOf,
  type Direction,
  type Filters,
  type Query,
  type Sort,
  type View,
} from './list-types.ts';

export const LIST_KEY = 'admin.reviews.moderation';

/** The document a saved filter holds: keys the page did not change are left out. */
export interface SavedPayload {
  readonly v: 1;
  readonly view: View;
  readonly filters?: Filters;
  readonly sort?: Sort;
  readonly direction?: Direction;
}

export type SavedModerationFilter = SavedFilter<SavedPayload>;
export type SavedModerationFilters = SavedFiltersAnswer<SavedPayload>;

/** Whether the page shows anything a saved filter could keep (a view, a filter or a sort). */
export function somethingToSave(query: Query): boolean {
  return (
    query.view !== DEFAULT_QUERY.view ||
    Object.keys(query.filters).length > 0 ||
    query.sort !== DEFAULT_QUERY.sort ||
    query.direction !== DEFAULT_QUERY.direction
  );
}

/** The document that saves what the page shows now. */
export function payloadOf(query: Query): SavedPayload {
  const filters = filtersOf(query.filters as Readonly<Record<string, string>>);
  return {
    v: 1,
    view: query.view,
    ...(Object.keys(filters).length === 0 ? {} : { filters }),
    ...(query.sort !== DEFAULT_QUERY.sort ? { sort: query.sort } : {}),
    ...(query.direction !== DEFAULT_QUERY.direction ? { direction: query.direction } : {}),
  };
}

/** The page query a saved filter opens, on its first page; a value the page does not know is dropped. */
export function queryOf(payload: SavedPayload): Query {
  return {
    ...DEFAULT_QUERY,
    view: VIEWS.find((value) => value === payload.view) ?? DEFAULT_QUERY.view,
    filters: filtersOf(stringsOf(payload.filters)),
    sort: SORTS.find((value) => value === payload.sort) ?? DEFAULT_QUERY.sort,
    direction:
      payload.direction === 'asc' || payload.direction === 'desc'
        ? payload.direction
        : DEFAULT_QUERY.direction,
  };
}
