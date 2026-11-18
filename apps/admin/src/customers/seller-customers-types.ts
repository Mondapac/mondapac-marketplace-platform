// The admin seller page's Customers tab (customers management phase 3): the API's answers, the
// list's query and the conversions between the query and the request body. Routes are under
// `customers/admin/sellers/:sellerId/customers/`; the key for both is `customers.customers.view`.

import { parseAmount } from '../wallet/money.ts';

export const SELLER_CUSTOMERS_PERMISSION = 'customers.customers.view';

export const SELLER_VIEWS = ['all', 'buyers', 'followers', 'referred'] as const;
export type SellerView = (typeof SELLER_VIEWS)[number];

export const SELLER_SORTS = [
  'last-order',
  'first-order',
  'orders',
  'spent',
  'followed',
  'code',
] as const;
export type SellerSort = (typeof SELLER_SORTS)[number];
export type Direction = 'asc' | 'desc';
/** Codes read A to Z first; dates and figures newest or largest first. */
export const defaultSellerDirection = (sort: SellerSort): Direction =>
  sort === 'code' ? 'asc' : 'desc';

export const CODE_SEARCH_MIN = 2;
export const CODE_SEARCH_MAX = 8;
export const SELLER_PAGE_SIZES = [25, 50, 100] as const;

/** The filters as typed; a filter that is not set is left out. Spent bounds are minor units. */
export interface SellerFilters {
  readonly follower?: 'yes' | 'no';
  readonly exclusive?: 'yes' | 'no';
  readonly lastOrderFrom?: string;
  readonly lastOrderTo?: string;
  readonly ordersMin?: string;
  readonly ordersMax?: string;
  readonly spentMin?: string;
  readonly spentMax?: string;
}
export const SELLER_FILTER_KEYS = [
  'follower',
  'exclusive',
  'lastOrderFrom',
  'lastOrderTo',
  'ordersMin',
  'ordersMax',
  'spentMin',
  'spentMax',
] as const satisfies readonly (keyof SellerFilters)[];
export type SellerFilterKey = (typeof SELLER_FILTER_KEYS)[number];

export const sellerFilterCount = (filters: SellerFilters): number =>
  SELLER_FILTER_KEYS.filter((key) => filters[key] !== undefined).length;

export interface SellerQuery {
  readonly view: SellerView;
  readonly q: string;
  readonly filters: SellerFilters;
  readonly sort: SellerSort;
  readonly direction: Direction;
  readonly page: number;
  readonly pageSize: number;
}

export const DEFAULT_SELLER_QUERY: SellerQuery = {
  view: 'all',
  q: '',
  filters: {},
  sort: 'last-order',
  direction: 'desc',
  page: 1,
  pageSize: 25,
};

/** The code symbols a search carries ("ab-12" reads as "ab12"). */
export const codeTerm = (q: string): string => q.replace(/[\s-]/g, '');

/** A code search shorter than the API takes (2 symbols) or longer than a code (8) is not sent. */
export const codeSearchOf = (q: string): string | undefined => {
  const text = codeTerm(q.trim());
  return text.length >= CODE_SEARCH_MIN && text.length <= CODE_SEARCH_MAX ? text : undefined;
};

export function sellerApiFilters(f: SellerFilters): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (f.follower !== undefined) out['follower'] = f.follower === 'yes';
  if (f.exclusive !== undefined) out['exclusive'] = f.exclusive === 'yes';
  for (const key of ['lastOrderFrom', 'lastOrderTo'] as const) {
    if (f[key] !== undefined) out[key] = f[key];
  }
  for (const key of ['ordersMin', 'ordersMax'] as const) {
    if (f[key] !== undefined) out[key] = Number(f[key]);
  }
  for (const key of ['spentMin', 'spentMax'] as const) {
    if (f[key] !== undefined) out[key] = f[key];
  }
  return out;
}

/** The body of the list request. */
export function sellerBodyOf(query: SellerQuery) {
  const filters = sellerApiFilters(query.filters);
  const q = codeSearchOf(query.q);
  return {
    view: query.view,
    ...(q === undefined ? {} : { q }),
    ...(Object.keys(filters).length === 0 ? {} : { filters }),
    sort: query.sort,
    direction: query.direction,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** A spent bound typed in the Market's currency, as minor-unit digits (null when not an amount). */
export function minorOfTyped(value: string, currency: string): string | null {
  if (/^0+(\.0+)?$/.test(value)) return '0';
  const parsed = parseAmount(value, currency);
  return parsed.ok && parsed.minor.length <= 15 ? parsed.minor : null;
}

export interface SellerCustomerRow {
  readonly accountId: string;
  readonly code: string;
  readonly firstName: string | null;
  readonly orderCount: number;
  readonly firstOrderAt: string | null;
  readonly lastOrderAt: string | null;
  /** Minor units as digits, or null when the customer never bought from the shop. */
  readonly spentMinor: string | null;
  readonly currency: string | null;
  readonly follower: boolean;
  readonly followedAt: string | null;
  readonly exclusive: boolean;
  readonly since: string;
}

export interface SellerCustomersPage {
  readonly items: readonly SellerCustomerRow[];
  readonly counts: Readonly<Record<SellerView, number>>;
  readonly paging: {
    readonly total: number;
    readonly page: number;
    readonly pageSize: number;
    readonly maxRows: number;
  } | null;
  readonly nextCursor: string | null;
}

export interface SellerCustomersSummary {
  readonly counts: Readonly<Record<SellerView, number>>;
  /** The IANA zone the months are cut in. */
  readonly zone: string;
  readonly months: readonly {
    /** `YYYY-MM` */
    readonly month: string;
    readonly newBuyers: number;
    readonly newFollowers: number;
  }[];
}

export const SELLER_OPTIONAL_COLUMNS = ['first-order', 'followed'] as const;
export type SellerOptionalColumn = (typeof SELLER_OPTIONAL_COLUMNS)[number];
