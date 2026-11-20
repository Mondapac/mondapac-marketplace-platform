// Saved filters of the unanswered-questions list (list key `admin.assistant.insights`, generic
// routes of the lists module). The route answers an unknown list key with an error until the
// lists module registers it, and the list then hides the saved-filter controls. The search text
// is never saved.

import { stringsOf, type SavedFilter, type SavedFiltersAnswer } from '../sales/sales-saved.ts';
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
} from './types.ts';

export const LIST_KEY = 'admin.assistant.insights';

export interface SavedPayload {
  readonly v: 1;
  readonly view: View;
  readonly filters?: Filters;
  readonly sort?: Sort;
  readonly direction?: Direction;
}

export type SavedInsightsFilter = SavedFilter<SavedPayload>;
export type SavedInsightsFilters = SavedFiltersAnswer<SavedPayload>;

export function somethingToSave(query: Query): boolean {
  return (
    query.view !== DEFAULT_QUERY.view ||
    Object.keys(query.filters).length > 0 ||
    query.sort !== DEFAULT_QUERY.sort ||
    query.direction !== DEFAULT_QUERY.direction
  );
}

export function payloadOf(query: Query): SavedPayload {
  const filters = filtersOf(query.filters);
  return {
    v: 1,
    view: query.view,
    ...(Object.keys(filters).length === 0 ? {} : { filters }),
    ...(query.sort !== DEFAULT_QUERY.sort ? { sort: query.sort } : {}),
    ...(query.direction !== DEFAULT_QUERY.direction ? { direction: query.direction } : {}),
  };
}

/** The page query a saved filter opens; a value the page does not know is dropped. */
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
