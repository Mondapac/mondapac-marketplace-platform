// The saved filters of the order list (ordering, `ordering/admin/saved-filters`): the document a
// saved view keeps, and the two conversions between it and the page's own state.

import type { SavedViewProblem, SavedViewVisibility } from '@mondapac/ui';
import type { ApiFailure } from '../api/client.ts';
import {
  DEFAULT_QUERY,
  presetDays,
  savedDays,
  sortIdOf,
  sortOf,
  type Query,
  type SortId,
} from './orders-query.ts';
import { FILTERS, type StatusFilter } from './types.ts';

/** The list the order page's saved views belong to. */
export const LIST_KEY = 'admin.ordering.orders';

/** The closed document of a saved view; keys the page does not set are left out. */
export interface SavedPayload {
  readonly v: 1;
  /** The status tab: all, or one status. */
  readonly tab: string;
  readonly filters?: {
    readonly paymentState?: string;
    readonly fulfilment?: string;
    readonly from?: string;
    readonly to?: string;
  };
  readonly sort?: SortId;
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

/**
 * The document that saves what the page shows now. A saved filter keeps calendar days, not the
 * name of a preset, so "Last 7 days" is saved as the days it means today.
 */
export function payloadOf(query: Query, zone: string, now: Date): SavedPayload {
  const { filters } = query;
  const days = filters.placed === undefined ? query.days : presetDays(filters.placed, zone, now);
  const conditions = {
    ...(filters.paymentState === undefined ? {} : { paymentState: filters.paymentState }),
    ...(filters.fulfilment === undefined ? {} : { fulfilment: filters.fulfilment }),
    ...(days === null
      ? {}
      : {
          ...(days.from === undefined ? {} : { from: days.from }),
          ...(days.to === undefined ? {} : { to: days.to }),
        }),
  };
  const sort = sortIdOf(query.sort, query.direction);
  return {
    v: 1,
    tab: query.tab,
    ...(Object.keys(conditions).length === 0 ? {} : { filters: conditions }),
    ...(sort === 'newest' ? {} : { sort }),
  };
}

/** The query a saved view opens: its tab, filters and sort, on the first page. */
export function queryOf(payload: SavedPayload): Query {
  const { from, to } = payload.filters ?? {};
  const { sort, direction } = sortOf(payload.sort ?? 'newest');
  return {
    ...DEFAULT_QUERY,
    tab: (FILTERS as readonly string[]).includes(payload.tab)
      ? (payload.tab as StatusFilter)
      : 'all',
    filters: {
      ...(payload.filters?.paymentState === undefined
        ? {}
        : { paymentState: payload.filters.paymentState }),
      ...(payload.filters?.fulfilment === undefined
        ? {}
        : { fulfilment: payload.filters.fulfilment }),
    },
    days: savedDays(from, to),
    sort,
    direction,
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
