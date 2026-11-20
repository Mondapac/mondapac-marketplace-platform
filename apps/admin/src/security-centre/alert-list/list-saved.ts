// Saved filters of the alert list (list key `admin.security.alerts`, generic routes of the lists
// module): the closed document a saved filter keeps, and the two conversions between it and the
// page's own query. The key search (an account id or an address) is never saved.

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

export const LIST_KEY = 'admin.security.alerts';

/** What a saved document holds of the filters: the API keeps severities as a list. */
export interface SavedFilters {
  readonly severities?: readonly string[];
  readonly rule?: string;
  readonly keyType?: string;
  readonly opened?: string;
  readonly minEvents?: number;
}

/** The document a saved filter holds: keys the page did not change are left out. */
export interface SavedPayload {
  readonly v: 1;
  readonly view: View;
  readonly filters?: SavedFilters;
  readonly sort?: Sort;
  readonly direction?: Direction;
}

export type SavedAlertFilter = SavedFilter<SavedPayload>;
export type SavedAlertFilters = SavedFiltersAnswer<SavedPayload>;

/** Whether the page shows anything a saved filter could keep (a view, a filter or a sort). */
export function somethingToSave(query: Query): boolean {
  return (
    query.view !== DEFAULT_QUERY.view ||
    Object.keys(query.filters).length > 0 ||
    query.sort !== DEFAULT_QUERY.sort ||
    query.direction !== DEFAULT_QUERY.direction
  );
}

function savedFilters(filters: Filters): SavedFilters {
  return {
    ...(filters.severity === undefined ? {} : { severities: [filters.severity] }),
    ...(filters.rule === undefined ? {} : { rule: filters.rule }),
    ...(filters.keyType === undefined ? {} : { keyType: filters.keyType }),
    ...(filters.opened === undefined ? {} : { opened: filters.opened }),
    ...(filters.minEvents === undefined ? {} : { minEvents: Number(filters.minEvents) }),
  };
}

/** The document that saves what the page shows now. */
export function payloadOf(query: Query): SavedPayload {
  const filters = savedFilters(filtersOf(query.filters as Readonly<Record<string, string>>));
  return {
    v: 1,
    view: query.view,
    ...(Object.keys(filters).length === 0 ? {} : { filters }),
    ...(query.sort !== DEFAULT_QUERY.sort ? { sort: query.sort } : {}),
    ...(query.direction !== DEFAULT_QUERY.direction ? { direction: query.direction } : {}),
  };
}

/**
 * The page query a saved filter opens, on its first page; a value the page does not know is
 * dropped. A document with several severities (the API allows them) opens on the first, the one the
 * panel can show.
 */
export function queryOf(payload: SavedPayload): Query {
  const raw = payload.filters;
  const values = stringsOf({
    severity: raw?.severities?.[0],
    rule: raw?.rule,
    keyType: raw?.keyType,
    opened: raw?.opened,
    minEvents: raw?.minEvents === undefined ? undefined : String(raw.minEvents),
  });
  return {
    ...DEFAULT_QUERY,
    view: VIEWS.find((value) => value === payload.view) ?? DEFAULT_QUERY.view,
    filters: filtersOf(values),
    sort: SORTS.find((value) => value === payload.sort) ?? DEFAULT_QUERY.sort,
    direction:
      payload.direction === 'asc' || payload.direction === 'desc'
        ? payload.direction
        : DEFAULT_QUERY.direction,
  };
}
