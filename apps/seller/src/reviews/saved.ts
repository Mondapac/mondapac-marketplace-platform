// The saved filters of the seller Reviews list (`catalog/seller/saved-filters`): the document a
// saved filter keeps, and the two conversions between it and the page's own query.

import type { SavedViewProblem, SavedViewVisibility } from '@mondapac/ui';
import type { ApiFailure } from '../api/client.ts';
import {
  DEFAULT_QUERY,
  SORT_FIELDS,
  VIEWS,
  defaultDirection,
  filtersOf,
  type Direction,
  type Query,
  type SortField,
  type View,
} from './query.ts';

/** The list the seller Reviews page's saved filters belong to. */
export const LIST_KEY = 'seller.reviews';

/** The flat document of a saved filter: the list's own selector, with a version. */
export interface SavedPayload {
  readonly v: 1;
  readonly view: View;
  readonly q?: string;
  readonly reply?: string;
  readonly minRating?: string;
  readonly maxRating?: string;
  readonly within?: string;
  readonly sort: SortField;
  readonly direction: Direction;
}

export interface SavedFilter {
  readonly id: string;
  readonly listKey: string;
  readonly name: string;
  readonly visibility: SavedViewVisibility;
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
  const { reply, minRating, maxRating, within } = query.filters;
  return {
    v: 1,
    view: query.tab,
    ...(q === '' ? {} : { q }),
    ...(reply === undefined ? {} : { reply }),
    ...(minRating === undefined ? {} : { minRating }),
    ...(maxRating === undefined ? {} : { maxRating }),
    ...(within === undefined ? {} : { within }),
    sort: query.sort,
    direction: query.direction,
  };
}

const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined =>
  list.find((entry) => entry === value);

/**
 * The query a saved filter opens, on its first page. A value the page does not know is dropped,
 * so the result is always one the list accepts.
 */
export function queryOf(payload: SavedPayload, pageSize: number): Query {
  const sort = oneOf(SORT_FIELDS, payload.sort) ?? DEFAULT_QUERY.sort;
  const values: Record<string, string> = {};
  for (const field of ['reply', 'minRating', 'maxRating', 'within'] as const) {
    const value = payload[field];
    if (typeof value === 'string') values[field] = value;
  }
  return {
    tab: oneOf(VIEWS, payload.view) ?? DEFAULT_QUERY.tab,
    q: payload.q ?? '',
    filters: filtersOf(values),
    sort,
    direction: oneOf(['asc', 'desc'] as const, payload.direction) ?? defaultDirection(),
    page: 1,
    pageSize,
  };
}

/** What a refused save, rename or delete says (one message per cause). */
export function problemOf(failure: ApiFailure): SavedViewProblem {
  if (failure.code === 'saved-filter.name-taken') return 'name-taken';
  if (failure.code === 'saved-filter.limit-reached') return 'limit';
  if (failure.code === 'saved-filter.shared-limit-reached') return 'shared-limit';
  if (failure.status === 401 || failure.status === 403) return 'denied';
  if (failure.code === 'validation.failed') {
    return failure.details?.fields?.some((field) => field.path === 'name')
      ? 'name-empty'
      : 'unavailable';
  }
  return 'unavailable';
}
