// The seller order list's query: what the tab, search, filters, sort and page ask
// GET ordering/seller/orders for. The list always asks for an offset page (`page`, with `paging`
// from the Market's List paging setting): page numbers get the total, Previous and next gets
// `hasNext`. The order board keeps the cursor read (`boardQuery`). Days are read on the seller's
// own clock (ADR-0005).
import { isDatePreset, presetRange, todayIn, type DatePreset } from './date-presets.ts';
import { DAY, startOfDay } from './orders-day.ts';
import type { FulfilmentFilter } from './types.ts';

export type ListPaging = 'pages' | 'prev-next';

export const PAGE_SIZE = 25;
/** The API stops page numbers at this row (ordering list contract); deeper rows need a filter. */
export const MAX_PAGED_ROWS = 10_000;

export const SORTS = ['newest', 'oldest', 'total-high', 'total-low'] as const;
/** The saved filter's sort ids, kept as the saved documents hold them. */
export type SortId = (typeof SORTS)[number];
export const SORT_FIELDS = ['paid', 'total'] as const;
export type SortField = (typeof SORT_FIELDS)[number];
export type Direction = 'asc' | 'desc';

const SORT_PARAMS: Readonly<Record<SortId, { sort: SortField; direction: Direction }>> = {
  newest: { sort: 'paid', direction: 'desc' },
  oldest: { sort: 'paid', direction: 'asc' },
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

/** Calendar days (yyyy-mm-dd, both included) on the seller's own clock. */
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

/** The conditions of the filter panel; each is one value. */
export interface Filters {
  /** A preset of the day the order was paid; worked out at each load. */
  readonly paid?: DatePreset;
}

export const FILTER_FIELDS = ['paid'] as const;

export interface Query {
  readonly tab: FulfilmentFilter;
  /** What was typed, trimmed: an order id. */
  readonly q: string;
  readonly filters: Filters;
  /** A custom range of paid days (from a saved filter); a `paid` preset replaces it. */
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
  sort: 'paid',
  direction: 'desc',
  page: 1,
};

export const filterCount = (query: Query): number =>
  Object.keys(query.filters).length +
  (query.days !== null && query.filters.paid === undefined ? 1 : 0);

/** The filters a panel answer holds: only a known value of a known field. */
export function filtersOf(values: Readonly<Record<string, string>>): Filters {
  const paid = values['paid'];
  return isDatePreset(paid) ? { paid } : {};
}

// The API's ids are canonical lower-case UUID v7 only. A typed id may be upper-case: the
// canonical (lower-case) form is sent. Anything else is not an id the API can find.
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SearchRoute =
  | { readonly kind: 'none' }
  /** Text that is not an order id: nothing is asked, and the box says what to type. */
  | { readonly kind: 'not-an-id' }
  | { readonly kind: 'q'; readonly value: string };

/** The seller search asks for one order by its id (the seller order's or the order's). */
export function routeSearch(text: string): SearchRoute {
  const value = text.trim();
  if (value === '') return { kind: 'none' };
  return UUID_V7.test(value) ? { kind: 'q', value: value.toLowerCase() } : { kind: 'not-an-id' };
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
  /** The IANA zone the days are read in: the seller's own working zone (ADR-0005). */
  readonly zone: string;
  readonly now: Date;
}

export function queryString(query: Query, context: QueryContext): string {
  const params = new URLSearchParams();
  if (query.tab !== 'all') params.set('status', query.tab);
  const route = routeSearch(query.q);
  if (route.kind === 'q') params.set('q', route.value);
  if (query.filters.paid !== undefined) {
    const range = presetRange(query.filters.paid, context.zone, context.now);
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

/** The path of the first page the server reads for the list: every order, newest first. */
export const firstPagePath = (paging: ListPaging): string =>
  `ordering/seller/orders?${queryString(DEFAULT_QUERY, { paging, zone: 'UTC', now: new Date() })}`;

/** The board reads each stage by cursor, newest first (it does not page by number). */
export function boardQuery(status: FulfilmentFilter, cursor: string | null): string {
  const params = new URLSearchParams();
  params.set('limit', '20');
  if (status !== 'all') params.set('status', status);
  if (cursor !== null) params.set('cursor', cursor);
  return `ordering/seller/orders?${params.toString()}`;
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

/**
 * The calendar days (both included) a preset means on the clock of `zone` at `now`, for a saved
 * filter, which keeps days and not the name of a preset. Null for a zone this runtime lacks.
 */
export function presetDays(preset: DatePreset, zone: string, now: Date): DayRange | null {
  const range = presetRange(preset, zone, now);
  if (range === null) return null;
  const from = todayIn(zone, new Date(range.from));
  const to = todayIn(zone, new Date(new Date(range.to).getTime() - 1));
  return from === null || to === null ? null : { from, to };
}
