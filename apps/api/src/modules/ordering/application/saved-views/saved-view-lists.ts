import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { SORT_IDS, type SavedFilterListKey } from '../../domain/saved-view';

// The order lists that have saved filters: for each, its key, who uses it and the vocabulary of a
// saved filter's document. A new list is a
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

export interface SavedFilterListDefinition {
  readonly key: SavedFilterListKey;
  readonly population: 'admin' | 'seller';
  /** Whether a filter of this list can be shared with everyone. */
  readonly shareable: boolean;
  readonly parsePayload: (value: unknown) => Result<OrderFilterPayload, ValidationFailure>;
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
];

/** The list a request names, or null for a key no list has. */
export function savedFilterListOf(key: unknown): SavedFilterListDefinition | null {
  return LISTS.find((list) => list.key === key) ?? null;
}
