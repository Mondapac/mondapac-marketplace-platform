// The saved filters of the seller order list (ordering, `ordering/seller/saved-filters`): the
// document a saved view keeps, and the two conversions between it and the page's own state. A
// seller's filters are personal: nothing here is shared with other accounts.

import type { SavedViewProblem, SavedViewVisibility } from '@mondapac/ui';
import type { ApiFailure } from '../api/client.ts';
import { NO_DAYS, type Days, type SortId } from './orders-query.ts';
import { FULFILMENT_FILTERS, type FulfilmentFilter } from './types.ts';

/** The list the order page's saved views belong to. */
export const LIST_KEY = 'seller.ordering.orders';

/** The closed document of a saved view; keys the page does not set are left out. */
export interface SavedPayload {
  readonly v: 1;
  /** The fulfilment tab: all, or one state. */
  readonly tab: string;
  readonly filters?: { readonly from?: string; readonly to?: string };
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

/** The document that saves what the page shows now. */
export function payloadOf(filter: FulfilmentFilter, days: Days, sort: SortId): SavedPayload {
  const conditions = {
    ...(days.from === '' ? {} : { from: days.from }),
    ...(days.to === '' ? {} : { to: days.to }),
  };
  return {
    v: 1,
    tab: filter,
    ...(Object.keys(conditions).length === 0 ? {} : { filters: conditions }),
    ...(sort === 'newest' ? {} : { sort }),
  };
}

/** The tab, days and sort a saved view opens. */
export function stateOf(payload: SavedPayload): {
  filter: FulfilmentFilter;
  days: Days;
  sort: SortId;
} {
  const tab = FULFILMENT_FILTERS.find((id) => id === payload.tab) ?? 'all';
  return {
    filter: tab,
    days: { ...NO_DAYS, from: payload.filters?.from ?? '', to: payload.filters?.to ?? '' },
    sort: payload.sort ?? 'newest',
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
