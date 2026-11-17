// The saved filters of the order list (ordering, `ordering/admin/saved-filters`): the document a
// saved view keeps, and the two conversions between it and the page's own state.

import type { SavedViewProblem, SavedViewVisibility } from '@mondapac/ui';
import type { ApiFailure } from '../api/client.ts';
import { NO_FILTERS, type OrderFilters, type SortId } from './orders-query.ts';

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

/** The document that saves what the page shows now. */
export function payloadOf(filters: OrderFilters, sort: SortId): SavedPayload {
  const conditions = {
    ...(filters.paymentState === '' ? {} : { paymentState: filters.paymentState }),
    ...(filters.fulfilment === '' ? {} : { fulfilment: filters.fulfilment }),
    ...(filters.from === '' ? {} : { from: filters.from }),
    ...(filters.to === '' ? {} : { to: filters.to }),
  };
  return {
    v: 1,
    tab: filters.status,
    ...(Object.keys(conditions).length === 0 ? {} : { filters: conditions }),
    ...(sort === 'newest' ? {} : { sort }),
  };
}

/** The filters and sort a saved view opens, on the first page. */
export function stateOf(payload: SavedPayload): { filters: OrderFilters; sort: SortId } {
  return {
    filters: {
      ...NO_FILTERS,
      status: payload.tab,
      paymentState: payload.filters?.paymentState ?? '',
      fulfilment: payload.filters?.fulfilment ?? '',
      from: payload.filters?.from ?? '',
      to: payload.filters?.to ?? '',
    },
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
