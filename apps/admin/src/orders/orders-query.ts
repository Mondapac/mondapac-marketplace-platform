// The admin order list's query: what the tab, search, filters, sort and page ask
// GET ordering/admin/orders for. The list always asks for an offset page (`page`, with `paging`
// from the Market's List paging setting): page numbers get the total, Previous and next gets
// `hasNext`. The days of a filter are read on the clock of the list's zone (ADR-0005).

import { DAY, startOfDay } from '../sales/day-start.ts';
import { isDatePreset, presetRange, todayIn, type DatePreset } from '../sales/date-presets.ts';
import { routeSearch } from '../sales/search-route.ts';
import type { StatusFilter } from './types.ts';

export type ListPaging = 'pages' | 'prev-next';

export const PAGE_SIZE = 25;
/** The API stops page numbers at this row (ordering list contract); deeper rows need a filter. */
export const MAX_PAGED_ROWS = 10_000;

export const PAYMENT_FILTERS = ['none', 'authorised', 'captured', 'voided'] as const;
export const FULFILMENT_FILTERS = ['to-ship', 'shipped', 'delivered'] as const;
export const FILTER_FIELDS = ['paymentState', 'fulfilment', 'placed'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

/** The saved filter's sort ids, kept as the saved documents hold them. */
export const SORTS = ['newest', 'oldest', 'total-high', 'total-low'] as const;
export type SortId = (typeof SORTS)[number];

export const SORT_FIELDS = ['created', 'total'] as const;
export type SortField = (typeof SORT_FIELDS)[number];
export type Direction = 'asc' | 'desc';

const SORT_PARAMS: Readonly<Record<SortId, { sort: SortField; direction: Direction }>> = {
  newest: { sort: 'created', direction: 'desc' },
  oldest: { sort: 'created', direction: 'asc' },
  'total-high': { sort: 'total', direction: 'desc' },
  'total-low': { sort: 'total', direction: 'asc' },
};

export const sortOf = (id: SortId) => SORT_PARAMS[id];

export function sortIdOf(sort: SortField, direction: Direction): SortId {
  return (
    SORTS.find((id) => SORT_PARAMS[id].sort === sort && SORT_PARAMS[id].direction === direction) ??
    'newest'
  );
}

/** Times start newest first and the total highest first. */
export const defaultDirection = (): Direction => 'desc';

/** The conditions of the filter panel; each is one value. */
export interface Filters {
  readonly paymentState?: string;
  readonly fulfilment?: string;
  /** A preset of the day the order was placed; worked out at each load. */
  readonly placed?: DatePreset;
}

/** Calendar days (yyyy-mm-dd, both included) of a saved filter or a range typed in a link. */
export type DayRange =
  | {
      /** The first day; the range may stop at `to` or run on without an upper bound. */
      readonly from: string;
      readonly to?: string;
    }
  | {
      /** The last day; a range with no `from` runs up to it with no lower bound. */
      readonly from?: undefined;
      readonly to: string;
    };

export interface Query {
  readonly tab: StatusFilter;
  /** What was typed, trimmed. */
  readonly q: string;
  readonly filters: Filters;
  /** A custom range of placed days (from a saved filter); a `placed` preset replaces it. */
  readonly days: DayRange | null;
  readonly sort: SortField;
  readonly direction: Direction;
  readonly page: number;
}

export const DEFAULT_QUERY: Query = {
  tab: 'all',
  q: '',
  filters: {},
  days: null,
  sort: 'created',
  direction: 'desc',
  page: 1,
};

export const filterCount = (query: Query): number =>
  Object.keys(query.filters).length +
  (query.days !== null && query.filters.placed === undefined ? 1 : 0);

/** The filters a panel answer holds: only a known value of a known field. */
export function filtersOf(values: Readonly<Record<string, string>>): Filters {
  const next: { paymentState?: string; fulfilment?: string; placed?: DatePreset } = {};
  const payment = PAYMENT_FILTERS.find((value) => value === values['paymentState']);
  if (payment !== undefined) next.paymentState = payment;
  const fulfilment = FULFILMENT_FILTERS.find((value) => value === values['fulfilment']);
  if (fulfilment !== undefined) next.fulfilment = fulfilment;
  const placed = values['placed'];
  if (isDatePreset(placed)) next.placed = placed;
  return next;
}

/**
 * The calendar days (both included) a preset means on the clock of `zone` at `now`, for a saved
 * filter, which keeps days and not the name of the preset. Null for a zone this runtime lacks.
 */
export function presetDays(preset: DatePreset, zone: string, now: Date): DayRange | null {
  const range = presetRange(preset, zone, now);
  const today = todayIn(zone, now);
  if (range === null || today === null) return null;
  const toDay = (instant: string): string | null => {
    // The day of an instant on the zone's clock: the same reading as `todayIn`.
    return todayIn(zone, new Date(instant));
  };
  const from = toDay(range.from);
  const lastInstant = new Date(new Date(range.to).getTime() - 1).toISOString();
  const to = toDay(lastInstant);
  return from === null || to === null ? null : { from, to };
}

/** True when both days are set and `to` is before `from`: the filter would match nothing. */
export const rangeIsBackwards = (days: DayRange | null): boolean =>
  days !== null &&
  days.from !== undefined &&
  days.to !== undefined &&
  DAY.test(days.from) &&
  DAY.test(days.to) &&
  days.to < days.from;

export interface QueryContext {
  readonly paging: ListPaging;
  /** The IANA zone the days are read in (the holder's own, else the Market's; ADR-0005). */
  readonly zone: string;
  readonly now: Date;
}

export function queryString(query: Query, context: QueryContext): string {
  const params = new URLSearchParams();
  const { filters } = query;
  if (query.tab !== 'all') params.set('status', query.tab);
  if (filters.paymentState !== undefined) params.set('paymentState', filters.paymentState);
  if (filters.fulfilment !== undefined) params.set('fulfilment', filters.fulfilment);
  const route = routeSearch(query.q);
  if (route.kind === 'q') params.set('q', route.value);
  else if (route.kind === 'search') params.set('search', route.value);
  if (filters.placed !== undefined) {
    const range = presetRange(filters.placed, context.zone, context.now);
    if (range !== null) {
      params.set('from', range.from);
      params.set('to', range.to);
    }
  } else if (query.days !== null) {
    // A range may have one bound only: the request then sends just that one.
    const from = query.days.from === undefined ? null : startOfDay(query.days.from, context.zone);
    // The last day is included: the API's `to` is the first instant after it.
    const to = query.days.to === undefined ? null : startOfDay(query.days.to, context.zone, 1);
    if (from !== null) params.set('from', from);
    if (to !== null) params.set('to', to);
  }
  params.set('page', String(query.page));
  params.set('pageSize', String(PAGE_SIZE));
  params.set('paging', context.paging);
  params.set('sort', query.sort);
  params.set('direction', query.direction);
  return params.toString();
}

/** The words around a day range; the app supplies them translated (next-intl, `orders.days.*`). */
export interface DaysWords {
  readonly range: (from: string, to: string) => string;
  readonly from: (day: string) => string;
  readonly until: (day: string) => string;
}

/** The days a query holds, named in words for a chip or a saved filter ("2026-10-01 to 2026-10-31"). */
export const daysLabel = (days: DayRange, words: DaysWords): string => {
  if (days.from !== undefined && days.to !== undefined) {
    return days.from === days.to ? days.from : words.range(days.from, days.to);
  }
  if (days.from !== undefined) return words.from(days.from);
  return words.until(days.to);
};

/** The range a saved document holds: only the bounds that are set; null when none is. */
export function savedDays(from: string | undefined, to: string | undefined): DayRange | null {
  const first = from === undefined || from === '' ? undefined : from;
  const last = to === undefined || to === '' ? undefined : to;
  if (first === undefined) return last === undefined ? null : { to: last };
  return last === undefined ? { from: first } : { from: first, to: last };
}
