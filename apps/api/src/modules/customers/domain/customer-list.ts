import { err, ok } from '@mondapac/shared-kernel';
import type { Id, Result, Temporal } from '@mondapac/shared-kernel';

// The vocabulary of the admin Customers list (a super list: views, search, filters, sort, paging,
// saved filters, export). Pure: it reads a request into a closed selector and knows nothing of the
// database. The application layer turns the selector into a query; the data comes from the
// `customer_directory` and `customer_stats` read models.

/** The tabs of the list. */
export const CUSTOMER_VIEWS = [
  'all',
  'new',
  'active',
  'inactive',
  'never-ordered',
  'disabled',
  'pending-deletion',
] as const;
export type CustomerView = (typeof CUSTOMER_VIEWS)[number];

/** Days a customer counts as new after signing up. */
export const NEW_WINDOW_DAYS = 30;
/** Days without an order after which an ordering customer counts as inactive. */
export const ACTIVE_WINDOW_DAYS = 90;

export const CUSTOMER_SORTS = ['joined', 'name', 'email', 'last-order', 'orders', 'spent'] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];
export type SortDirection = 'asc' | 'desc';

/** The search text's length bounds, in characters after trimming. */
export const CUSTOMER_SEARCH_MIN = 2;
export const CUSTOMER_SEARCH_MAX = 80;

/** Page numbers stop at this row; deeper rows are reached by narrowing the filter. */
export const CUSTOMER_MAX_PAGED_ROWS = 10_000;
export const CUSTOMER_DEFAULT_PAGE_SIZE = 25;
export const CUSTOMER_MAX_PAGE_SIZE = 100;
/** Customers one export may hold; more is refused whole and the admin narrows the filter. */
export const CUSTOMER_EXPORT_MAX_ROWS = 10_000;

export const CUSTOMER_FILTER_KEYS = [
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
] as const;
export type CustomerFilterKey = (typeof CUSTOMER_FILTER_KEYS)[number];

/** A day as a request writes it, `YYYY-MM-DD`; the range is [from 00:00, to + 1 day) in UTC. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value: unknown): value is string =>
  typeof value === 'string' && DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/** What a request selects: the tab, the search text and the filters, each already validated. */
export interface CustomerSelector {
  readonly view: CustomerView;
  /** Trimmed search text, or null. An address, a name or an order id (the reader decides). */
  readonly text: string | null;
  readonly status: 'active' | 'disabled' | null;
  readonly verified: boolean | null;
  readonly joinedFrom: string | null;
  readonly joinedTo: string | null;
  readonly lastOrderFrom: string | null;
  readonly lastOrderTo: string | null;
  readonly ordersMin: number | null;
  readonly ordersMax: number | null;
  /** Minor units of the Market's currency. */
  readonly spentMin: bigint | null;
  readonly spentMax: bigint | null;
}

export interface CustomerFieldFailure {
  readonly path: string;
  readonly code: string;
}

const fail = (path: string, code: string): Result<never, CustomerFieldFailure> =>
  err({ path, code });

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): Result<T, CustomerFieldFailure> {
  if (typeof value !== 'string') return fail(path, 'type');
  const found = allowed.find((candidate) => candidate === value);
  return found === undefined ? fail(path, 'value') : ok(found);
}

function count(value: unknown, path: string): Result<number, CustomerFieldFailure> {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1_000_000) return fail(path, 'range');
  return ok(parsed);
}

function minor(value: unknown, path: string): Result<bigint, CustomerFieldFailure> {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    return ok(BigInt(value));
  if (typeof value === 'string' && /^\d{1,15}$/.test(value)) return ok(BigInt(value));
  return fail(path, 'range');
}

function bool(value: unknown, path: string): Result<boolean, CustomerFieldFailure> {
  if (value === true || value === 'true') return ok(true);
  if (value === false || value === 'false') return ok(false);
  return fail(path, 'value');
}

const present = (value: unknown): boolean => value !== undefined && value !== null && value !== '';

/**
 * Reads a view, a search text and the filters. `prefix` names the path in a failure (a saved
 * document reports `payload.filters.status`, a request `status`). Every key outside the closed set
 * is refused by the caller before this runs.
 */
export function parseCustomerSelector(
  raw: {
    readonly view?: unknown;
    readonly q?: unknown;
    readonly filters?: Readonly<Record<string, unknown>>;
  },
  prefix = '',
  filterPrefix = prefix,
): Result<CustomerSelector, CustomerFieldFailure> {
  const view = present(raw.view)
    ? oneOf(raw.view, CUSTOMER_VIEWS, `${prefix}view`)
    : ok('all' as const);
  if (!view.ok) return view;

  let text: string | null = null;
  if (present(raw.q)) {
    if (typeof raw.q !== 'string') return fail(`${prefix}q`, 'type');
    const trimmed = raw.q.trim();
    if (
      Array.from(trimmed).length < CUSTOMER_SEARCH_MIN ||
      Array.from(trimmed).length > CUSTOMER_SEARCH_MAX ||
      /\p{C}/u.test(trimmed)
    ) {
      return fail(`${prefix}q`, 'length');
    }
    text = trimmed;
  }

  const filters = raw.filters ?? {};
  const path = (key: string): string => `${filterPrefix}${key}`;
  const selector = {
    view: view.value,
    text,
    status: null as CustomerSelector['status'],
    verified: null as boolean | null,
    joinedFrom: null as string | null,
    joinedTo: null as string | null,
    lastOrderFrom: null as string | null,
    lastOrderTo: null as string | null,
    ordersMin: null as number | null,
    ordersMax: null as number | null,
    spentMin: null as bigint | null,
    spentMax: null as bigint | null,
  };

  if (present(filters['status'])) {
    const status = oneOf(filters['status'], ['active', 'disabled'] as const, path('status'));
    if (!status.ok) return status;
    selector.status = status.value;
  }
  if (present(filters['verified'])) {
    const verified = bool(filters['verified'], path('verified'));
    if (!verified.ok) return verified;
    selector.verified = verified.value;
  }
  for (const key of ['joinedFrom', 'joinedTo', 'lastOrderFrom', 'lastOrderTo'] as const) {
    if (!present(filters[key])) continue;
    const value = filters[key];
    if (!isDay(value)) return fail(path(key), 'format');
    selector[key] = value;
  }
  for (const key of ['ordersMin', 'ordersMax'] as const) {
    if (!present(filters[key])) continue;
    const value = count(filters[key], path(key));
    if (!value.ok) return value;
    selector[key] = value.value;
  }
  for (const key of ['spentMin', 'spentMax'] as const) {
    if (!present(filters[key])) continue;
    const value = minor(filters[key], path(key));
    if (!value.ok) return value;
    selector[key] = value.value;
  }

  // A range that cannot match anything is a request error, not an empty list.
  if (
    selector.joinedFrom !== null &&
    selector.joinedTo !== null &&
    selector.joinedTo < selector.joinedFrom
  ) {
    return fail(path('joinedTo'), 'range');
  }
  if (
    selector.lastOrderFrom !== null &&
    selector.lastOrderTo !== null &&
    selector.lastOrderTo < selector.lastOrderFrom
  ) {
    return fail(path('lastOrderTo'), 'range');
  }
  if (
    selector.ordersMin !== null &&
    selector.ordersMax !== null &&
    selector.ordersMax < selector.ordersMin
  ) {
    return fail(path('ordersMax'), 'range');
  }
  if (
    selector.spentMin !== null &&
    selector.spentMax !== null &&
    selector.spentMax < selector.spentMin
  ) {
    return fail(path('spentMax'), 'range');
  }
  return ok(selector);
}

/** The filters of a selector as the closed `filters` object of a saved document (empty left out). */
export function filtersOf(selector: CustomerSelector): Record<string, string | boolean | number> {
  const filters: Record<string, string | boolean | number> = {};
  if (selector.status !== null) filters['status'] = selector.status;
  if (selector.verified !== null) filters['verified'] = selector.verified;
  for (const key of ['joinedFrom', 'joinedTo', 'lastOrderFrom', 'lastOrderTo'] as const) {
    const value = selector[key];
    if (value !== null) filters[key] = value;
  }
  for (const key of ['ordersMin', 'ordersMax'] as const) {
    const value = selector[key];
    if (value !== null) filters[key] = value;
  }
  for (const key of ['spentMin', 'spentMax'] as const) {
    const value = selector[key];
    if (value !== null) filters[key] = Number(value);
  }
  return filters;
}

export function parseSort(
  sort: unknown,
  direction: unknown,
): Result<
  { readonly sort: CustomerSort; readonly direction: SortDirection },
  CustomerFieldFailure
> {
  const key = present(sort) ? oneOf(sort, CUSTOMER_SORTS, 'sort') : ok('joined' as const);
  if (!key.ok) return key;
  const order = present(direction)
    ? oneOf(direction, ['asc', 'desc'] as const, 'direction')
    : ok('desc' as const);
  if (!order.ok) return order;
  return ok({ sort: key.value, direction: order.value });
}

/** A customer as the list shows them (personal data: a use case answers it only to the permission). */
export interface CustomerListRow {
  readonly accountId: Id<'Account'>;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: 'active' | 'disabled';
  readonly emailVerified: boolean;
  readonly signedUpAt: Temporal.Instant;
  readonly firstOrderAt: Temporal.Instant | null;
  readonly lastOrderAt: Temporal.Instant | null;
  readonly orderCount: number;
  readonly spentMinor: bigint;
  readonly currency: string | null;
  readonly refundCount: number;
  readonly refundedMinor: bigint;
}
