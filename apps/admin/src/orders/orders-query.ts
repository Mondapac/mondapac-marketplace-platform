// The admin order list's query: what the filters and the sort ask GET ordering/admin/orders for.

export type ListPaging = 'pages' | 'prev-next';

export const PAGE_SIZE = 25;
/** The API stops page numbers at this row (ordering list contract); deeper rows need a filter. */
export const MAX_PAGED_ROWS = 10_000;
export const MAX_PAGE = Math.floor(MAX_PAGED_ROWS / PAGE_SIZE);

export const PAYMENT_FILTERS = ['none', 'authorised', 'captured', 'voided'] as const;
export const FULFILMENT_FILTERS = ['to-ship', 'shipped', 'delivered'] as const;
export const SORTS = ['newest', 'oldest', 'total-high', 'total-low'] as const;
export type SortId = (typeof SORTS)[number];

const SORT_PARAMS: Readonly<Record<SortId, { sort: string; direction: string }>> = {
  newest: { sort: 'created', direction: 'desc' },
  oldest: { sort: 'created', direction: 'asc' },
  'total-high': { sort: 'total', direction: 'desc' },
  'total-low': { sort: 'total', direction: 'asc' },
};

export interface OrderFilters {
  readonly status: string;
  readonly paymentState: string;
  readonly fulfilment: string;
  /** Calendar days (yyyy-mm-dd) in UTC, the zone the table shows; '' keeps every day. */
  readonly from: string;
  readonly to: string;
}

export const NO_FILTERS: OrderFilters = {
  status: 'all',
  paymentState: '',
  fulfilment: '',
  from: '',
  to: '',
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The start of a UTC day as an ISO instant; null for a value that is not a real day. */
function startOfDay(day: string, plus = 0): string | null {
  if (!DAY.test(day)) return null;
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(time) ? null : new Date(time + plus * 86_400_000).toISOString();
}

/** True when both days are set and `to` is before `from`: the filter would match nothing. */
export const rangeIsBackwards = (filters: OrderFilters): boolean =>
  DAY.test(filters.from) && DAY.test(filters.to) && filters.to < filters.from;

export function queryOf(
  filters: OrderFilters,
  mode:
    | { readonly paging: 'pages'; readonly page: number; readonly sort: SortId }
    | {
        readonly paging: 'prev-next';
        readonly cursor: string | null;
      },
): string {
  const params = new URLSearchParams();
  if (filters.status !== 'all') params.set('status', filters.status);
  if (filters.paymentState !== '') params.set('paymentState', filters.paymentState);
  if (filters.fulfilment !== '') params.set('fulfilment', filters.fulfilment);
  const from = startOfDay(filters.from);
  // The last day is included: the API's `to` is the first instant after it.
  const to = startOfDay(filters.to, 1);
  if (from !== null) params.set('from', from);
  if (to !== null) params.set('to', to);
  if (mode.paging === 'pages') {
    params.set('page', String(mode.page));
    params.set('pageSize', String(PAGE_SIZE));
    const sort = SORT_PARAMS[mode.sort];
    params.set('sort', sort.sort);
    params.set('direction', sort.direction);
  } else if (mode.cursor !== null) {
    params.set('cursor', mode.cursor);
  }
  return params.toString();
}

/** How many page buttons a total needs, never past the API's depth limit. */
export const pageCountOf = (total: number): number =>
  Math.min(MAX_PAGE, Math.max(1, Math.ceil(total / PAGE_SIZE)));
