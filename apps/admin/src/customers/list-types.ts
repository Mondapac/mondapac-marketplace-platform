// The admin Customers super list (customers management phase 1, B2): the API's answer, the
// page's query and the conversions between the query, the request body and a saved filter.

import type { GroupRef } from './groups-types.ts';

export const LIST_PERMISSION = 'customers.customers.view';
export const EXPORT_PERMISSION = 'customers.customers.export';
export const SHARE_PERMISSION = 'customers.saved-filter.share';
export const STATUS_PERMISSION = 'identity.customer-account.disable';
/** The saved filters of this list (customers.saved_filters). */
export const LIST_KEY = 'admin.customers.customers';

export const VIEWS = [
  'all',
  'new',
  'active',
  'inactive',
  'never-ordered',
  'disabled',
  'pending-deletion',
] as const;
export type View = (typeof VIEWS)[number];

export const SORTS = ['joined', 'last-order', 'orders', 'spent', 'name', 'email'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';
/** Names and emails read A to Z first; dates and figures newest or largest first. */
export const defaultDirection = (sort: Sort): Direction =>
  sort === 'name' || sort === 'email' ? 'asc' : 'desc';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 80;
export const PAGE_SIZE = 25;
export const PAGE_SIZES = [25, 50, 100] as const;
/** "Select all matching" and an export take at most this many customers. */
export const SELECT_MAX = 10_000;

/** The list's filters; a filter that is not set is left out. Amounts in minor units, as digits. */
export interface Filters {
  readonly status?: 'active' | 'disabled';
  readonly verified?: 'yes' | 'no';
  /** Calendar days (YYYY-MM-DD), both ends included, as the API takes them. */
  readonly joinedFrom?: string;
  readonly joinedTo?: string;
  readonly lastOrderFrom?: string;
  readonly lastOrderTo?: string;
  readonly ordersMin?: string;
  readonly ordersMax?: string;
  readonly spentMin?: string;
  readonly spentMax?: string;
  /** A manual group's id (phase 2a): only its members. */
  readonly group?: string;
}
export const FILTER_KEYS = [
  'status',
  'verified',
  'joinedFrom',
  'joinedTo',
  'lastOrderFrom',
  'lastOrderTo',
  'ordersMin',
  'ordersMax',
  'spentMin',
  'spentMax',
  'group',
] as const satisfies readonly (keyof Filters)[];
export type FilterKey = (typeof FILTER_KEYS)[number];

export const filterCount = (filters: Filters): number =>
  FILTER_KEYS.filter((key) => filters[key] !== undefined).length;

export interface Query {
  readonly view: View;
  readonly q: string;
  /**
   * An order's id (phase 2b): the list narrows to the customer who placed it. The API reads it on
   * the list only, so it is not part of a saved filter, the selector or an export.
   */
  readonly orderNumber: string;
  readonly filters: Filters;
  readonly sort: Sort;
  readonly direction: Direction;
  readonly page: number;
  readonly pageSize: number;
}

export const DEFAULT_QUERY: Query = {
  view: 'all',
  q: '',
  orderNumber: '',
  filters: {},
  sort: 'joined',
  direction: 'desc',
  page: 1,
  pageSize: PAGE_SIZE,
};

/** A search shorter than the API takes is not sent (the box says why). */
export const searchOf = (q: string): string | undefined => {
  const text = q.trim();
  return text.length >= SEARCH_MIN ? text : undefined;
};

export const ORDER_NUMBER_MAX = 64;

/** The order number as the API takes it (trimmed, at most 64 characters), or undefined when empty. */
export const orderNumberOf = (orderNumber: string): string | undefined => {
  const text = orderNumber.trim();
  return text === '' ? undefined : text;
};

/** The filters as the API takes them (also the `filters` of a saved document). */
export function apiFilters(f: Filters): Record<string, string | number | boolean> {
  const filters: Record<string, string | number | boolean> = {};
  if (f.status !== undefined) filters['status'] = f.status;
  if (f.verified !== undefined) filters['verified'] = f.verified === 'yes';
  for (const key of ['joinedFrom', 'joinedTo', 'lastOrderFrom', 'lastOrderTo'] as const) {
    if (f[key] !== undefined) filters[key] = f[key];
  }
  for (const key of ['ordersMin', 'ordersMax'] as const) {
    if (f[key] !== undefined) filters[key] = Number(f[key]);
  }
  for (const key of ['spentMin', 'spentMax'] as const) {
    if (f[key] !== undefined) filters[key] = f[key];
  }
  if (f.group !== undefined) filters['group'] = f.group;
  return filters;
}

/** The page's filters from the API's shape (a saved document); unknown values are dropped. */
export function filtersOfApi(raw: Readonly<Record<string, unknown>> | undefined): Filters {
  if (raw === undefined) return {};
  const out: Record<string, string> = {};
  if (raw['status'] === 'active' || raw['status'] === 'disabled') out['status'] = raw['status'];
  if (typeof raw['verified'] === 'boolean') out['verified'] = raw['verified'] ? 'yes' : 'no';
  for (const key of ['joinedFrom', 'joinedTo', 'lastOrderFrom', 'lastOrderTo'] as const) {
    const value = raw[key];
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) out[key] = value;
  }
  for (const key of ['ordersMin', 'ordersMax', 'spentMin', 'spentMax'] as const) {
    const value = raw[key];
    if ((typeof value === 'number' || typeof value === 'string') && /^\d+$/.test(String(value))) {
      out[key] = String(value);
    }
  }
  const group = raw['group'];
  if (typeof group === 'string' && UUID.test(group)) out['group'] = group.toLowerCase();
  return out;
}

/** The selector part of a request: tab, search and filters, as the API takes them. */
export function selectorOf(query: Query) {
  const filters = apiFilters(query.filters);
  const q = searchOf(query.q);
  return {
    view: query.view,
    ...(q === undefined ? {} : { q }),
    ...(Object.keys(filters).length === 0 ? {} : { filters }),
  };
}

export interface CustomerRow {
  readonly accountId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: 'active' | 'disabled';
  readonly emailVerified: boolean;
  readonly signedUpAt: string;
  readonly lastOrderAt: string | null;
  readonly orderCount: number;
  /** Minor units of `currency`, as digits. */
  readonly spentMinor: string;
  readonly currency: string | null;
  readonly refundCount: number;
  /** The manual groups the customer is in (phase 2a; absent from an older API). */
  readonly groups?: readonly GroupRef[];
}

export interface CustomersPage {
  readonly items: readonly CustomerRow[];
  readonly counts: Readonly<Record<View, number>>;
  readonly paging: {
    readonly total: number;
    readonly page: number;
    readonly pageSize: number;
    readonly maxRows: number;
  } | null;
  readonly nextCursor: string | null;
}

/** The customer's name as a title: the display name, or the email when there is none. */
export const titleOf = (row: { readonly displayName: string | null; readonly email: string }) =>
  row.displayName !== null && row.displayName.trim() !== '' ? row.displayName : row.email;

export const OPTIONAL_COLUMNS = [
  'status',
  'joined',
  'orders',
  'spent',
  'last-order',
  'verified',
  'refunds',
  'groups',
] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];
export const DEFAULT_COLUMNS: readonly OptionalColumn[] = [
  'status',
  'joined',
  'orders',
  'spent',
  'last-order',
];

/** A stored column choice, with unknown ids dropped; nothing stored means the defaults. */
export function cleanColumns(
  stored: readonly string[] | null | undefined,
): readonly OptionalColumn[] {
  if (stored === null || stored === undefined) return DEFAULT_COLUMNS;
  return stored.filter((id): id is OptionalColumn =>
    (OPTIONAL_COLUMNS as readonly string[]).includes(id),
  );
}

// Saved filters (customers.saved_filters): the closed document a saved tab keeps.

export interface SavedPayload {
  readonly v: 1;
  readonly view: View;
  readonly q?: string;
  readonly filters?: Readonly<Record<string, unknown>>;
  readonly sort?: Sort;
  readonly direction?: Direction;
}

export interface SavedFilter {
  readonly id: string;
  readonly name: string;
  readonly visibility: 'me' | 'everyone';
  readonly payload: SavedPayload;
  readonly ownedByMe: boolean;
  readonly canManage: boolean;
  readonly count?: number | null;
}

export interface SavedFiltersAnswer {
  readonly items: readonly SavedFilter[];
  readonly canShare: boolean;
  readonly limits: { readonly perOwner: number; readonly shared: number };
}

export function payloadOf(query: Query): SavedPayload {
  const q = searchOf(query.q);
  return {
    v: 1,
    view: query.view,
    ...(q === undefined ? {} : { q }),
    ...(filterCount(query.filters) === 0 ? {} : { filters: apiFilters(query.filters) }),
    sort: query.sort,
    direction: query.direction,
  };
}

export function queryOfPayload(payload: SavedPayload, pageSize: number): Query {
  const sort = (SORTS as readonly string[]).includes(payload.sort ?? '')
    ? (payload.sort as Sort)
    : DEFAULT_QUERY.sort;
  return {
    view: (VIEWS as readonly string[]).includes(payload.view) ? payload.view : 'all',
    q: payload.q ?? '',
    orderNumber: '',
    filters: filtersOfApi(payload.filters),
    sort,
    direction: payload.direction ?? defaultDirection(sort),
    page: 1,
    pageSize,
  };
}
