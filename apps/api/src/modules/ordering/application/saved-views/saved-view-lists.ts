import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { SORT_IDS, type SavedFilterListKey } from '../../domain/saved-view';

// The order lists that have saved filters: for each, its key, who uses it and the vocabulary of a
// saved filter's document (the Orders lists, and the admin Sales lists Shipments, Refunds and
// Invoices, whose panels use the generic lists routes). A new list is a
// new entry here (the table keeps any dotted key). The vocabulary mirrors what the panels ask the
// list routes for (`GET ordering/admin/orders`, `GET ordering/seller/orders`).

export type ValidationFailure = {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
};

export const invalid = (path: string, code: string): { ok: false; error: ValidationFailure } =>
  err({ code: 'validation.failed', fields: [{ path, code }] }) as {
    ok: false;
    error: ValidationFailure;
  };

const ADMIN_TABS = ['all', 'pending-payment', 'confirmed', 'cancelled'] as const;
const SELLER_TABS = ['all', 'to-ship', 'shipped', 'delivered'] as const;
const PAYMENT_STATES = ['none', 'authorised', 'captured', 'voided'] as const;
const FULFILMENTS = ['to-ship', 'shipped', 'delivered'] as const;

/** The closed document of a saved filter, in its canonical form (an empty part is left out). */
export interface OrderFilterPayload {
  readonly v: 1;
  readonly tab: string;
  readonly filters?: {
    readonly paymentState?: string;
    readonly fulfilment?: string;
    readonly from?: string;
    readonly to?: string;
  };
  readonly sort?: string;
}

/**
 * The closed document of a saved filter of an admin Sales list (Shipments, Refunds, Invoices), in
 * its canonical form: `v` and `tab` always; `filters` only when one is set, in the list's order;
 * `sort` and `direction` only when given. Every value is a word of the list's vocabulary: a date
 * filter is a relative preset the panel resolves in the list's time zone when the filter is
 * opened, never a stored date. Search text is never part of it.
 */
export interface SalesListFilterPayload {
  readonly v: 1;
  readonly tab: string;
  readonly filters?: Readonly<Record<string, string>>;
  readonly sort?: string;
  readonly direction?: 'asc' | 'desc';
}

/** The canonical document of any order list's saved filter. */
export type SavedFilterPayload = OrderFilterPayload | SalesListFilterPayload;

export interface SavedFilterListDefinition {
  readonly key: SavedFilterListKey;
  readonly population: 'admin' | 'seller';
  /** Whether a filter of this list can be shared with everyone. */
  readonly shareable: boolean;
  readonly parsePayload: (value: unknown) => Result<SavedFilterPayload, ValidationFailure>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value: unknown): value is string =>
  typeof value === 'string' && DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): Result<T, ValidationFailure> {
  if (typeof value !== 'string') return invalid(path, 'type');
  const found = allowed.find((candidate) => candidate === value);
  return found === undefined ? invalid(path, 'value') : ok(found);
}

function payloadParser(options: {
  readonly tabs: readonly string[];
  readonly filterKeys: readonly ('paymentState' | 'fulfilment' | 'from' | 'to')[];
}): (value: unknown) => Result<OrderFilterPayload, ValidationFailure> {
  return (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return invalid('payload', 'type');
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!['v', 'tab', 'filters', 'sort'].includes(key)) {
        return invalid(`payload.${key}`, 'unknown');
      }
    }
    if (record['v'] !== 1) return invalid('payload.v', 'value');
    const tab = oneOf(record['tab'] ?? 'all', options.tabs, 'payload.tab');
    if (!tab.ok) return tab;

    const filters: { -readonly [K in keyof NonNullable<OrderFilterPayload['filters']>]: string } =
      {};
    const rawFilters = record['filters'];
    if (rawFilters !== undefined && rawFilters !== null) {
      if (typeof rawFilters !== 'object' || Array.isArray(rawFilters)) {
        return invalid('payload.filters', 'type');
      }
      const given = rawFilters as Record<string, unknown>;
      for (const key of Object.keys(given)) {
        if (!(options.filterKeys as readonly string[]).includes(key)) {
          return invalid(`payload.filters.${key}`, 'unknown');
        }
      }
      for (const key of options.filterKeys) {
        const entry = given[key];
        if (entry === undefined || entry === null || entry === '') continue;
        const path = `payload.filters.${key}`;
        if (key === 'paymentState') {
          const found = oneOf(entry, PAYMENT_STATES, path);
          if (!found.ok) return found;
          filters.paymentState = found.value;
        } else if (key === 'fulfilment') {
          const found = oneOf(entry, FULFILMENTS, path);
          if (!found.ok) return found;
          filters.fulfilment = found.value;
        } else {
          if (!isDay(entry)) return invalid(path, 'format');
          filters[key] = entry;
        }
      }
      if (filters.from !== undefined && filters.to !== undefined && filters.to < filters.from) {
        return invalid('payload.filters.to', 'range');
      }
    }

    let sort: string | undefined;
    if (record['sort'] !== undefined && record['sort'] !== null) {
      const found = oneOf(record['sort'], SORT_IDS, 'payload.sort');
      if (!found.ok) return found;
      if (found.value !== 'newest') sort = found.value;
    }

    return ok({
      v: 1,
      tab: tab.value,
      ...(Object.keys(filters).length > 0 ? { filters } : {}),
      ...(sort !== undefined ? { sort } : {}),
    });
  };
}

/** The relative date presets of a Sales list's date filter (resolved by the panel, never stored as dates). */
const DATE_PRESETS = [
  'today',
  'yesterday',
  'last-7-days',
  'last-30-days',
  'this-month',
  'last-month',
] as const;
const DIRECTIONS = ['asc', 'desc'] as const;

/**
 * The parser of a Sales list's document. Each filter is one word of its own vocabulary; an empty
 * entry (absent, null or '') is dropped. Refusals use the same paths and codes as the order list.
 */
function salesListParser(options: {
  readonly tabs: readonly string[];
  readonly defaultTab: string;
  /** The filters in their canonical order, each with its vocabulary. */
  readonly filters: readonly (readonly [string, readonly string[]])[];
  readonly sorts: readonly string[];
}): (value: unknown) => Result<SalesListFilterPayload, ValidationFailure> {
  const filterKeys = options.filters.map(([key]) => key);
  return (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return invalid('payload', 'type');
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!['v', 'tab', 'filters', 'sort', 'direction'].includes(key)) {
        return invalid(`payload.${key}`, 'unknown');
      }
    }
    if (record['v'] !== 1) return invalid('payload.v', 'value');
    const tab = oneOf(record['tab'] ?? options.defaultTab, options.tabs, 'payload.tab');
    if (!tab.ok) return tab;

    const filters: Record<string, string> = {};
    const rawFilters = record['filters'];
    if (rawFilters !== undefined && rawFilters !== null) {
      if (typeof rawFilters !== 'object' || Array.isArray(rawFilters)) {
        return invalid('payload.filters', 'type');
      }
      const given = rawFilters as Record<string, unknown>;
      for (const key of Object.keys(given)) {
        if (!filterKeys.includes(key)) return invalid(`payload.filters.${key}`, 'unknown');
      }
      for (const [key, allowed] of options.filters) {
        const entry = given[key];
        if (entry === undefined || entry === null || entry === '') continue;
        const found = oneOf(entry, allowed, `payload.filters.${key}`);
        if (!found.ok) return found;
        filters[key] = found.value;
      }
    }

    let sort: string | undefined;
    if (record['sort'] !== undefined && record['sort'] !== null) {
      const found = oneOf(record['sort'], options.sorts, 'payload.sort');
      if (!found.ok) return found;
      sort = found.value;
    }
    let direction: 'asc' | 'desc' | undefined;
    if (record['direction'] !== undefined && record['direction'] !== null) {
      const found = oneOf(record['direction'], DIRECTIONS, 'payload.direction');
      if (!found.ok) return found;
      direction = found.value;
    }

    return ok({
      v: 1,
      tab: tab.value,
      ...(Object.keys(filters).length > 0 ? { filters } : {}),
      ...(sort !== undefined ? { sort } : {}),
      ...(direction !== undefined ? { direction } : {}),
    });
  };
}

const LISTS: readonly SavedFilterListDefinition[] = [
  {
    key: 'admin.ordering.orders',
    population: 'admin',
    shareable: true,
    parsePayload: payloadParser({
      tabs: ADMIN_TABS,
      filterKeys: ['paymentState', 'fulfilment', 'from', 'to'],
    }),
  },
  {
    key: 'seller.ordering.orders',
    population: 'seller',
    shareable: false,
    parsePayload: payloadParser({
      tabs: SELLER_TABS,
      filterKeys: ['from', 'to'],
    }),
  },
  {
    key: 'admin.ordering.shipments',
    population: 'admin',
    shareable: true,
    parsePayload: salesListParser({
      tabs: ['all', 'attention', 'to-prepare', 'ready', 'shipped', 'delivered', 'refunded'],
      defaultTab: 'all',
      filters: [
        ['deliveryMethod', ['pickup', 'instant', 'same_day', 'scheduled']],
        ['attention', ['any', 'no-carrier', 'carrier-unknown', 'cancel-unknown']],
        ['paid', DATE_PRESETS],
        ['shipped', DATE_PRESETS],
      ],
      sorts: ['paid', 'shipped', 'delivered', 'total'],
    }),
  },
  {
    key: 'admin.ordering.refunds',
    population: 'admin',
    shareable: true,
    parsePayload: salesListParser({
      tabs: ['all', 'pending', 'succeeded', 'failed'],
      defaultTab: 'all',
      filters: [
        [
          'reason',
          [
            'not-received',
            'damaged',
            'wrong-item',
            'not-as-described',
            'seller-cancelled',
            'item-unavailable',
            'other',
          ],
        ],
        ['actor', ['admin', 'seller']],
        ['lossBearer', ['seller', 'platform']],
        ['ledger', ['waiting', 'recorded']],
        ['requested', DATE_PRESETS],
      ],
      sorts: ['requested', 'settled', 'amount'],
    }),
  },
  {
    // The Invoices page: order confirmations and credit notes.
    key: 'admin.ordering.documents',
    population: 'admin',
    shareable: true,
    parsePayload: salesListParser({
      tabs: ['order-confirmation', 'credit-note'],
      defaultTab: 'order-confirmation',
      filters: [['issued', DATE_PRESETS]],
      sorts: ['issued', 'amount'],
    }),
  },
];

/** The list a request names, or null for a key no list has. */
export function savedFilterListOf(key: unknown): SavedFilterListDefinition | null {
  return LISTS.find((list) => list.key === key) ?? null;
}
