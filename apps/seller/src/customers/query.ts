// The seller Customers list's query: what the view, search, filters, sort and page ask
// `POST customers/seller/customers/list` for. Days are YYYY-MM-DD; money bounds are minor units.
import type { CustomerView } from './types.ts';

export type ListPaging = 'pages' | 'prev-next';
export const PAGE_SIZE = 25;
export const MAX_PAGED_ROWS = 10_000;

export const SORT_FIELDS = [
  'last-order',
  'first-order',
  'orders',
  'spent',
  'followed',
  'code',
] as const;
export type SortField = (typeof SORT_FIELDS)[number];
export type Direction = 'asc' | 'desc';

/** Every filter as the text the panel holds; `yes` and `no` for the two flags. */
export const FILTER_KEYS = [
  'follower',
  'exclusive',
  'lastOrderFrom',
  'lastOrderTo',
  'ordersMin',
  'ordersMax',
  'spentMin',
  'spentMax',
] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export type Filters = Partial<Record<FilterKey, string>>;

export interface Query {
  readonly view: CustomerView;
  readonly q: string;
  readonly filters: Filters;
  readonly sort: SortField;
  readonly direction: Direction;
  readonly page: number;
}

export const DEFAULT_QUERY: Query = {
  view: 'all',
  q: '',
  filters: {},
  sort: 'last-order',
  direction: 'desc',
  page: 1,
};

export const defaultDirection = (sort: SortField): Direction => (sort === 'code' ? 'asc' : 'desc');

/**
 * A code or its start: 2 to 8 letters and digits, the dash and spaces left out (the API reads O as
 * 0, I and L as 1, and refuses U).
 */
const CODE_TERM = /^[0-9A-Za-z]{2,8}$/;
export const searchIsValid = (text: string): boolean =>
  CODE_TERM.test(text.trim().replace(/[\s-]/g, ''));

/** The `view`, `q` and `filters` of a request (the selector the codes and export routes share). */
export function selectorOf(query: Query): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  for (const key of FILTER_KEYS) {
    const value = query.filters[key];
    if (value === undefined || value === '') continue;
    if (key === 'follower' || key === 'exclusive') filters[key] = value === 'yes';
    else if (key === 'ordersMin' || key === 'ordersMax') filters[key] = Number(value);
    else filters[key] = value;
  }
  return {
    view: query.view,
    ...(query.q === '' ? {} : { q: query.q }),
    ...(Object.keys(filters).length === 0 ? {} : { filters }),
  };
}

/** The body of the list request: always a page (the Market's List paging decides the footer). */
export function listBody(query: Query): Record<string, unknown> {
  return {
    ...selectorOf(query),
    sort: query.sort,
    direction: query.direction,
    page: query.page,
    pageSize: PAGE_SIZE,
  };
}

/** How many filter conditions are set (a range counts once). */
export function filterCount(filters: Filters): number {
  const names = new Set<string>();
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value !== undefined && value !== '') names.add(key.replace(/(From|To|Min|Max)$/, ''));
  }
  return names.size;
}
