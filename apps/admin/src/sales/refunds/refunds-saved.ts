// Saved filters of the Refunds list (list key `admin.ordering.refunds`, generic routes of the
// lists module): the closed document a saved filter keeps, and the two conversions between it and
// the page's own query. The search text and the seller link are never saved.

import type { SavedFilter, SavedFiltersAnswer } from '../sales-saved.ts';
import { stringsOf } from '../sales-saved.ts';
import {
  DEFAULT_QUERY,
  FILTER_FIELDS,
  SORTS,
  TABS,
  filtersOf,
  type Direction,
  type Filters,
  type Query,
  type Sort,
  type Tab,
} from './refunds-types.ts';

export const LIST_KEY = 'admin.ordering.refunds';

/** The document the API validates: keys the page did not change are left out. */
export interface SavedPayload {
  readonly v: 1;
  readonly tab: Tab;
  readonly filters?: Filters;
  readonly sort?: Sort;
  readonly direction?: Direction;
}

export type SavedRefund = SavedFilter<SavedPayload>;
export type SavedRefunds = SavedFiltersAnswer<SavedPayload>;

/** Whether the page shows anything a saved filter could keep (a tab, a filter or a sort). */
export function somethingToSave(query: Query, paging: 'pages' | 'prev-next'): boolean {
  return (
    query.tab !== DEFAULT_QUERY.tab ||
    Object.keys(query.filters).length > 0 ||
    (paging === 'pages' &&
      (query.sort !== DEFAULT_QUERY.sort || query.direction !== DEFAULT_QUERY.direction))
  );
}

/** The document that saves what the page shows now. */
export function payloadOf(query: Query, paging: 'pages' | 'prev-next'): SavedPayload {
  const filters = Object.fromEntries(
    FILTER_FIELDS.flatMap((field) =>
      query.filters[field] === undefined ? [] : [[field, query.filters[field]]],
    ),
  ) as Filters;
  const sorted = paging === 'pages';
  return {
    v: 1,
    tab: query.tab,
    ...(Object.keys(filters).length === 0 ? {} : { filters }),
    ...(sorted && query.sort !== DEFAULT_QUERY.sort ? { sort: query.sort } : {}),
    ...(sorted && query.direction !== DEFAULT_QUERY.direction
      ? { direction: query.direction }
      : {}),
  };
}

/** The page query a saved filter opens, on its first page; a value the page does not know is dropped. */
export function queryOf(payload: SavedPayload, paging: 'pages' | 'prev-next'): Query {
  const tab = TABS.find((value) => value === payload.tab) ?? DEFAULT_QUERY.tab;
  // Previous and next keeps to the default sort: a saved sort needs page numbers.
  const sort = paging === 'pages' ? SORTS.find((value) => value === payload.sort) : undefined;
  return {
    ...DEFAULT_QUERY,
    tab,
    filters: filtersOf(stringsOf(payload.filters)),
    sort: sort ?? DEFAULT_QUERY.sort,
    direction:
      paging === 'pages' && (payload.direction === 'asc' || payload.direction === 'desc')
        ? payload.direction
        : DEFAULT_QUERY.direction,
  };
}
