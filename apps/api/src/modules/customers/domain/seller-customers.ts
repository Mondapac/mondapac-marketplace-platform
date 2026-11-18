import { err, ok } from '@mondapac/shared-kernel';
import type { Id, Money, Result, Temporal } from '@mondapac/shared-kernel';

// A customer as one seller sees them (customers management phase 3). The relation is kept per
// seller: "bought" from the customer's confirmed orders with that seller, "follows" from their
// follow of the store, and (phase 4) "exclusive". Each seller knows a customer only by the
// customer's code for that seller and their first name: never the account id, the email, the
// full name or anything the customer did with another seller. Pure: no I/O.

/** Crockford base32: no I, L, O or U, so a code read aloud or typed is not mistaken. */
export const CUSTOMER_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** `XXXX-XXXX`: 40 random bits, drawn when the seller first meets the customer. */
export const CUSTOMER_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/** Builds the code from 8 symbols of the alphabet. */
export function formatCustomerCode(symbols: string): string {
  return `${symbols.slice(0, 4)}-${symbols.slice(4, 8)}`;
}

/**
 * A code (or the start of one) as a seller types it, in the stored form's symbols: upper case,
 * the dash and spaces dropped, O read as 0 and I or L as 1 (Crockford). Null when what is left is
 * not 1 to 8 symbols of the alphabet.
 */
export function normalizeCodeTerm(raw: string): string | null {
  const symbols = raw.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (symbols.length < 1 || symbols.length > 8) return null;
  for (const symbol of symbols) if (!CUSTOMER_CODE_ALPHABET.includes(symbol)) return null;
  return symbols;
}

/** The stored-form prefix of a normalized term: `ABCD` stays, `ABCDE` becomes `ABCD-E`. */
export function codePrefixOf(symbols: string): string {
  return symbols.length <= 4 ? symbols : `${symbols.slice(0, 4)}-${symbols.slice(4)}`;
}

/** The first name a seller may see: the first word of the display name, at most 40 characters. */
export function firstNameOf(displayName: string | null): string | null {
  if (displayName === null) return null;
  const first = displayName.trim().split(/\s+/u)[0] ?? '';
  if (first.length === 0) return null;
  return Array.from(first).slice(0, 40).join('');
}

/** What the customer's orders with one seller add up to, as `ordering` answers it. */
export interface SellerOrderTotals {
  readonly sellerId: Id<'Seller'>;
  readonly orderCount: number;
  readonly firstOrderAt: Temporal.Instant;
  readonly lastOrderAt: Temporal.Instant;
  readonly spentMinor: bigint;
  readonly currency: string;
}

/** One store the customer follows, as `engagement` answers it. */
export interface FollowedStore {
  readonly sellerId: Id<'Seller'>;
  readonly followedAt: Temporal.Instant;
}

/** The written state of one (seller, customer) row, without the code. */
export interface SellerCustomerEntry {
  readonly sellerId: Id<'Seller'>;
  readonly accountId: Id<'Account'>;
  readonly orderCount: number;
  readonly firstOrderAt: Temporal.Instant | null;
  readonly lastOrderAt: Temporal.Instant | null;
  readonly spentMinor: bigint;
  readonly currency: string | null;
  readonly follower: boolean;
  readonly followedAt: Temporal.Instant | null;
  /** The customer signed up through this seller's invite link and the attribution is active. */
  readonly exclusive: boolean;
}

/**
 * The rows one customer should have: one per seller they bought from, follow or are the exclusive
 * customer of (phase 4), sorted by seller. A seller with none of these has no row (and its row, if
 * any, is removed).
 */
export function sellerCustomerEntriesOf(
  accountId: Id<'Account'>,
  totals: readonly SellerOrderTotals[],
  follows: readonly FollowedStore[],
  exclusiveSellerId: Id<'Seller'> | null = null,
): SellerCustomerEntry[] {
  const bySeller = new Map<string, SellerCustomerEntry>();
  for (const total of totals) {
    if (total.orderCount <= 0) continue;
    bySeller.set(total.sellerId, {
      sellerId: total.sellerId,
      accountId,
      orderCount: total.orderCount,
      firstOrderAt: total.firstOrderAt,
      lastOrderAt: total.lastOrderAt,
      spentMinor: total.spentMinor > 0n ? total.spentMinor : 0n,
      currency: total.currency,
      follower: false,
      followedAt: null,
      exclusive: false,
    });
  }
  for (const follow of follows) {
    const seen = bySeller.get(follow.sellerId);
    bySeller.set(follow.sellerId, {
      ...(seen ?? {
        sellerId: follow.sellerId,
        accountId,
        orderCount: 0,
        firstOrderAt: null,
        lastOrderAt: null,
        spentMinor: 0n,
        currency: null,
        exclusive: false,
      }),
      follower: true,
      followedAt: follow.followedAt,
    });
  }
  if (exclusiveSellerId !== null) {
    const seen = bySeller.get(exclusiveSellerId);
    bySeller.set(exclusiveSellerId, {
      ...(seen ?? {
        sellerId: exclusiveSellerId,
        accountId,
        orderCount: 0,
        firstOrderAt: null,
        lastOrderAt: null,
        spentMinor: 0n,
        currency: null,
        follower: false,
        followedAt: null,
      }),
      exclusive: true,
    });
  }
  return [...bySeller.values()].sort((a, b) =>
    a.sellerId < b.sellerId ? -1 : a.sellerId > b.sellerId ? 1 : 0,
  );
}

// The seller's Customers list (a super list: views, search, filters, sort, paging, select all,
// export). Saved filters arrive with the shared list kit's generic endpoints (B0-1b).

export const SELLER_CUSTOMER_VIEWS = ['all', 'buyers', 'followers', 'referred'] as const;
export type SellerCustomerTab = (typeof SELLER_CUSTOMER_VIEWS)[number];

export const SELLER_CUSTOMER_SORTS = [
  'last-order',
  'first-order',
  'orders',
  'spent',
  'followed',
  'code',
] as const;
export type SellerCustomerSort = (typeof SELLER_CUSTOMER_SORTS)[number];

export const SELLER_CUSTOMER_FILTER_KEYS = [
  'follower',
  'exclusive',
  'lastOrderFrom',
  'lastOrderTo',
  'ordersMin',
  'ordersMax',
  'spentMin',
  'spentMax',
] as const;

export const SELLER_CUSTOMER_DEFAULT_PAGE_SIZE = 25;
export const SELLER_CUSTOMER_MAX_PAGE_SIZE = 100;
/** Rows one select-all or one export may hold; more is refused whole. */
export const SELLER_CUSTOMER_MAX_SELECTED = 10_000;

/** What a seller list request selects (validated). Search is by customer code only. */
export interface SellerCustomerSelector {
  readonly view: SellerCustomerTab;
  /** The stored-form prefix of a code, or null. */
  readonly codePrefix: string | null;
  readonly follower: boolean | null;
  /** Only the customers who signed up through the shop's link (true) or the others (false). */
  readonly exclusive: boolean | null;
  readonly lastOrderFrom: string | null;
  readonly lastOrderTo: string | null;
  readonly ordersMin: number | null;
  readonly ordersMax: number | null;
  readonly spentMin: bigint | null;
  readonly spentMax: bigint | null;
}

export interface FieldFailure {
  readonly path: string;
  readonly code: string;
}

const present = (value: unknown): boolean => value !== undefined && value !== null && value !== '';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value: unknown): value is string =>
  typeof value === 'string' && DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads `view`, `q` and `filters` of a request. Every other key is the caller's to refuse. */
export function parseSellerCustomerSelector(input: {
  readonly view?: unknown;
  readonly q?: unknown;
  readonly filters?: unknown;
}): Result<SellerCustomerSelector, FieldFailure> {
  let view: SellerCustomerTab = 'all';
  if (present(input.view)) {
    const found = SELLER_CUSTOMER_VIEWS.find((candidate) => candidate === input.view);
    if (found === undefined) return err({ path: 'view', code: 'value' });
    view = found;
  }
  let codePrefix: string | null = null;
  if (present(input.q)) {
    if (typeof input.q !== 'string' || input.q.length > 20)
      return err({ path: 'q', code: 'length' });
    const symbols = normalizeCodeTerm(input.q);
    if (symbols === null || symbols.length < 2) return err({ path: 'q', code: 'format' });
    codePrefix = codePrefixOf(symbols);
  }
  const selector = {
    view,
    codePrefix,
    follower: null as boolean | null,
    exclusive: null as boolean | null,
    lastOrderFrom: null as string | null,
    lastOrderTo: null as string | null,
    ordersMin: null as number | null,
    ordersMax: null as number | null,
    spentMin: null as bigint | null,
    spentMax: null as bigint | null,
  };
  const filters = input.filters;
  if (filters !== undefined && filters !== null) {
    if (!isRecord(filters)) return err({ path: 'filters', code: 'type' });
    for (const key of Object.keys(filters)) {
      if (!(SELLER_CUSTOMER_FILTER_KEYS as readonly string[]).includes(key)) {
        return err({ path: `filters.${key}`, code: 'unknown' });
      }
    }
    const path = (key: string) => `filters.${key}`;
    for (const key of ['follower', 'exclusive'] as const) {
      if (!present(filters[key])) continue;
      const value = filters[key];
      if (value !== true && value !== false) return err({ path: path(key), code: 'value' });
      selector[key] = value;
    }
    for (const key of ['lastOrderFrom', 'lastOrderTo'] as const) {
      if (!present(filters[key])) continue;
      if (!isDay(filters[key])) return err({ path: path(key), code: 'format' });
      selector[key] = filters[key];
    }
    for (const key of ['ordersMin', 'ordersMax'] as const) {
      if (!present(filters[key])) continue;
      const value = filters[key];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1e6) {
        return err({ path: path(key), code: 'range' });
      }
      selector[key] = value;
    }
    for (const key of ['spentMin', 'spentMax'] as const) {
      if (!present(filters[key])) continue;
      const value = filters[key];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
        selector[key] = BigInt(value);
      } else if (typeof value === 'string' && /^\d{1,15}$/.test(value)) {
        selector[key] = BigInt(value);
      } else {
        return err({ path: path(key), code: 'range' });
      }
    }
  }
  const backwards = (low: unknown, high: unknown) => low !== null && high !== null && high! < low!;
  if (backwards(selector.lastOrderFrom, selector.lastOrderTo)) {
    return err({ path: 'filters.lastOrderTo', code: 'range' });
  }
  if (backwards(selector.ordersMin, selector.ordersMax)) {
    return err({ path: 'filters.ordersMax', code: 'range' });
  }
  if (backwards(selector.spentMin, selector.spentMax)) {
    return err({ path: 'filters.spentMax', code: 'range' });
  }
  return ok(selector);
}

/** A row of the seller's list. No account id, email or full name. */
export interface SellerCustomerView {
  readonly code: string;
  readonly firstName: string | null;
  readonly orderCount: number;
  readonly firstOrderAt: Temporal.Instant | null;
  readonly lastOrderAt: Temporal.Instant | null;
  /** Null when the customer never bought from the seller. */
  readonly spent: Money | null;
  readonly follower: boolean;
  readonly followedAt: Temporal.Instant | null;
  readonly exclusive: boolean;
  readonly since: Temporal.Instant;
}

/** A stored row as the repository reads it: the seller's view plus the account (never answered to a seller). */
export interface SellerCustomerRecord extends SellerCustomerView {
  readonly sellerId: Id<'Seller'>;
  readonly accountId: Id<'Account'>;
}

/** A seller's view of a record: the account id is dropped here, once. */
export function sellerViewOf(record: SellerCustomerRecord): SellerCustomerView {
  return {
    code: record.code,
    firstName: record.firstName,
    orderCount: record.orderCount,
    firstOrderAt: record.firstOrderAt,
    lastOrderAt: record.lastOrderAt,
    spent: record.spent,
    follower: record.follower,
    followedAt: record.followedAt,
    exclusive: record.exclusive,
    since: record.since,
  };
}
