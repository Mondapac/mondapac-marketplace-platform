// Saved filters of the "Needs a look" list (list key `admin.sellers.health-queue`, generic routes
// of the lists module): the closed document a saved filter keeps, and the two conversions between
// it and the page's own query. The search text is never saved.

import { stringsOf } from '../sales/sales-saved.ts';
import {
  DEFAULT_QUERY,
  defaultDirection,
  isScore,
  type Filters,
  type Query,
} from './health-list-query.ts';
import { SORTS, VIEWS, type Direction, type Sort, type View } from './health-types.ts';

export const LIST_KEY = 'admin.sellers.health-queue';

/** The document a saved filter holds: keys the page did not change are left out. */
export interface SavedPayload {
  readonly v: 1;
  readonly view: View;
  readonly filters?: { minScore?: string; maxScore?: string };
  readonly sort?: Sort;
  readonly direction?: Direction;
}

/** Whether the page shows anything a saved filter could keep (a view, a score range or a sort). */
export function somethingToSave(query: Query): boolean {
  return (
    query.view !== DEFAULT_QUERY.view ||
    Object.keys(query.filters).length > 0 ||
    query.sort !== DEFAULT_QUERY.sort ||
    query.direction !== defaultDirection(query.sort)
  );
}

/** The document that saves what the page shows now. */
export function payloadOf(query: Query): SavedPayload {
  const filters: Filters = {
    ...(query.filters.minScore === undefined ? {} : { minScore: query.filters.minScore }),
    ...(query.filters.maxScore === undefined ? {} : { maxScore: query.filters.maxScore }),
  };
  return {
    v: 1,
    view: query.view,
    ...(Object.keys(filters).length === 0 ? {} : { filters }),
    ...(query.sort !== DEFAULT_QUERY.sort ? { sort: query.sort } : {}),
    ...(query.direction !== defaultDirection(query.sort) ? { direction: query.direction } : {}),
  };
}

/** The page query a saved filter opens, on its first page; a value the page does not know is dropped. */
export function queryOf(payload: SavedPayload): Query {
  const strings = stringsOf(payload.filters);
  const min = strings['minScore'];
  const max = strings['maxScore'];
  const filters: Filters = {
    ...(min !== undefined && isScore(min) ? { minScore: min } : {}),
    ...(max !== undefined && isScore(max) ? { maxScore: max } : {}),
  };
  const sort = SORTS.find((value) => value === payload.sort) ?? DEFAULT_QUERY.sort;
  return {
    ...DEFAULT_QUERY,
    view: VIEWS.find((value) => value === payload.view) ?? DEFAULT_QUERY.view,
    filters,
    sort,
    direction:
      payload.direction === 'asc' || payload.direction === 'desc'
        ? payload.direction
        : defaultDirection(sort),
  };
}
