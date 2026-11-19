// Saved filters of the System requests queue (list key `admin.system-requests.requests`, the
// generic routes of the lists module): the closed document a saved filter keeps, and the two
// conversions between it and the queue's own query. The search text and the deep-link subject
// (a setting page's banner) are never saved; the page size stays the admin's.

import type { SavedFilter, SavedFiltersAnswer } from '../sales/sales-saved.ts';
import {
  AREAS,
  DEFAULT_QUERY,
  NO_FILTERS,
  RISKS,
  SORTS,
  STATUSES,
  defaultDirection,
  isView,
  type Direction,
  type Query,
  type Sort,
  type View,
} from './types.ts';

export const LIST_KEY = 'admin.system-requests.requests';

/** The document the API validates: parts the queue did not change are left out. */
export interface SavedPayload {
  readonly v: 1;
  readonly view: View;
  readonly filters?: {
    readonly area?: readonly string[];
    readonly risk?: readonly string[];
    readonly status?: readonly string[];
    /** Calendar days (yyyy-mm-dd) on the admin's clock. */
    readonly from?: string;
    readonly to?: string;
    readonly overdue?: true;
  };
  readonly sort?: Sort;
  readonly direction?: Direction;
}

export type SavedRequestFilter = SavedFilter<SavedPayload>;
export type SavedRequestFilters = SavedFiltersAnswer<SavedPayload>;

/** The values of `allowed` that `value` holds, in the vocabulary's order (the API's canonical form). */
const wordsOf = (value: unknown, allowed: readonly string[]): readonly string[] =>
  Array.isArray(value) ? allowed.filter((word) => value.includes(word)) : [];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether the queue shows a filter or a sort a saved filter could keep (the view alone counts too). */
export function somethingToSave(query: Query): boolean {
  const { filters } = query;
  return (
    query.view !== DEFAULT_QUERY.view ||
    filters.area.length > 0 ||
    filters.risk.length > 0 ||
    filters.status.length > 0 ||
    filters.from !== '' ||
    filters.to !== '' ||
    filters.overdue ||
    query.sort !== DEFAULT_QUERY.sort ||
    query.direction !== defaultDirection(query.sort)
  );
}

/** The document that saves what the queue shows now. */
export function payloadOf(query: Query): SavedPayload {
  const { filters } = query;
  const kept = {
    ...(filters.area.length > 0 ? { area: wordsOf(filters.area, AREAS) } : {}),
    ...(filters.risk.length > 0 ? { risk: wordsOf(filters.risk, RISKS) } : {}),
    ...(filters.status.length > 0 ? { status: wordsOf(filters.status, STATUSES) } : {}),
    ...(filters.from !== '' ? { from: filters.from } : {}),
    ...(filters.to !== '' ? { to: filters.to } : {}),
    ...(filters.overdue ? { overdue: true as const } : {}),
  };
  return {
    v: 1,
    view: query.view,
    ...(Object.keys(kept).length === 0 ? {} : { filters: kept }),
    ...(query.sort !== DEFAULT_QUERY.sort ? { sort: query.sort } : {}),
    ...(query.direction !== defaultDirection(query.sort) ? { direction: query.direction } : {}),
  };
}

/** The query a saved filter opens, on its first page; a value the queue does not know is dropped. */
export function queryOf(payload: SavedPayload, pageSize: number): Query {
  const view = isView(payload.view) ? payload.view : DEFAULT_QUERY.view;
  const sort = SORTS.find((value) => value === payload.sort) ?? DEFAULT_QUERY.sort;
  const filters = payload.filters ?? {};
  const day = (value: unknown) => (typeof value === 'string' && DAY.test(value) ? value : '');
  return {
    ...DEFAULT_QUERY,
    view,
    filters: {
      ...NO_FILTERS,
      area: wordsOf(filters.area, AREAS),
      risk: wordsOf(filters.risk, RISKS),
      status: wordsOf(filters.status, STATUSES),
      from: day(filters.from),
      to: day(filters.to),
      overdue: filters.overdue === true,
    },
    sort,
    direction:
      payload.direction === 'asc' || payload.direction === 'desc'
        ? payload.direction
        : defaultDirection(sort),
    pageSize,
  };
}
