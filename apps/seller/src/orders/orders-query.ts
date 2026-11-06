// The seller order list's query: what the tabs, the days and the sort ask
// GET ordering/seller/orders for.
import type { FulfilmentFilter } from './types.ts';

export type ListPaging = 'pages' | 'prev-next';

export const PAGE_SIZE = 25;
/** The API stops page numbers at this row (ordering list contract); deeper rows need a filter. */
export const MAX_PAGED_ROWS = 10_000;
export const MAX_PAGE = Math.floor(MAX_PAGED_ROWS / PAGE_SIZE);

export const SORTS = ['newest', 'oldest', 'total-high', 'total-low'] as const;
export type SortId = (typeof SORTS)[number];

const SORT_PARAMS: Readonly<Record<SortId, { sort: string; direction: string }>> = {
  newest: { sort: 'paid', direction: 'desc' },
  oldest: { sort: 'paid', direction: 'asc' },
  'total-high': { sort: 'total', direction: 'desc' },
  'total-low': { sort: 'total', direction: 'asc' },
};

export interface Days {
  /** Calendar days (yyyy-mm-dd) in UTC; '' keeps every day. */
  readonly from: string;
  readonly to: string;
}

export const NO_DAYS: Days = { from: '', to: '' };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The start of a UTC day as an ISO instant; null for a value that is not a real day. */
function startOfDay(day: string, plus = 0): string | null {
  if (!DAY.test(day)) return null;
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(time) ? null : new Date(time + plus * 86_400_000).toISOString();
}

/** True when both days are set and `to` is before `from`: the filter would match nothing. */
export const rangeIsBackwards = (days: Days): boolean =>
  DAY.test(days.from) && DAY.test(days.to) && days.to < days.from;

export function queryOf(
  status: FulfilmentFilter,
  days: Days,
  mode:
    | { readonly paging: 'pages'; readonly page: number; readonly sort: SortId }
    | { readonly paging: 'prev-next'; readonly cursor: string | null },
): string {
  const params = new URLSearchParams();
  if (mode.paging === 'pages') {
    params.set('page', String(mode.page));
    params.set('pageSize', String(PAGE_SIZE));
    const sort = SORT_PARAMS[mode.sort];
    params.set('sort', sort.sort);
    params.set('direction', sort.direction);
  } else {
    params.set('limit', '20');
  }
  if (status !== 'all') params.set('status', status);
  const from = startOfDay(days.from);
  // The last day is included: the API's `to` is the first instant after it.
  const to = startOfDay(days.to, 1);
  if (from !== null) params.set('from', from);
  if (to !== null) params.set('to', to);
  if (mode.paging === 'prev-next' && mode.cursor !== null) params.set('cursor', mode.cursor);
  return `ordering/seller/orders?${params.toString()}`;
}

/** The query of the export: the tab and the days, without any page, sort or cursor. */
export function exportQueryOf(status: FulfilmentFilter, days: Days): string {
  const params = new URLSearchParams();
  if (status !== 'all') params.set('status', status);
  const from = startOfDay(days.from);
  const to = startOfDay(days.to, 1);
  if (from !== null) params.set('from', from);
  if (to !== null) params.set('to', to);
  return params.toString();
}

/** How many page buttons a total needs, never past the API's depth limit. */
export const pageCountOf = (total: number): number =>
  Math.min(MAX_PAGE, Math.max(1, Math.ceil(total / PAGE_SIZE)));
