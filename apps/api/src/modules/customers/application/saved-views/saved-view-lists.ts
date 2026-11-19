import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import {
  CUSTOMER_FILTER_KEYS,
  filtersOf,
  parseCustomerSelector,
  parseSort,
  type CustomerSort,
  type CustomerView,
  type SortDirection,
} from '../../domain/customer-list';
import type { SavedFilterListKey } from '../../domain/saved-filter';
import type { AttributionView } from '../ports/seller-invitations.repository';
import { attributionSelectorOf } from '../seller-invitations-flow';

// The lists that have saved filters: for each, its key, who uses it and the vocabulary of a saved
// filter's document. A new list is a new entry here (the table keeps any dotted key). The
// vocabulary mirrors what the page asks the list route for (`POST customers/admin/list`).

export type ValidationFailure = {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
};

export const invalid = (path: string, code: string): { ok: false; error: ValidationFailure } =>
  err({ code: 'validation.failed', fields: [{ path, code }] }) as {
    ok: false;
    error: ValidationFailure;
  };

/** The closed document of a saved filter, in its canonical form (an empty part is left out). */
export interface CustomerFilterPayload {
  readonly v: 1;
  readonly view: CustomerView | AttributionView;
  readonly q?: string;
  readonly filters?: Readonly<Record<string, string | number | boolean>>;
  readonly sort?: CustomerSort | 'attributed';
  readonly direction?: SortDirection;
}

export interface SavedFilterListDefinition {
  readonly key: SavedFilterListKey;
  readonly population: 'admin' | 'seller';
  /** Whether a filter of this list can be shared with everyone. */
  readonly shareable: boolean;
  readonly parsePayload: (value: unknown) => Result<CustomerFilterPayload, ValidationFailure>;
}

const PAYLOAD_KEYS = ['v', 'view', 'q', 'filters', 'sort', 'direction'];

function parseCustomersPayload(value: unknown): Result<CustomerFilterPayload, ValidationFailure> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('payload', 'type');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PAYLOAD_KEYS.includes(key)) return invalid(`payload.${key}`, 'unknown');
  }
  if (record['v'] !== 1) return invalid('payload.v', 'value');
  const filters = record['filters'];
  if (filters !== undefined && filters !== null) {
    if (typeof filters !== 'object' || Array.isArray(filters)) {
      return invalid('payload.filters', 'type');
    }
    for (const key of Object.keys(filters)) {
      if (!(CUSTOMER_FILTER_KEYS as readonly string[]).includes(key)) {
        return invalid(`payload.filters.${key}`, 'unknown');
      }
    }
  }
  const selector = parseCustomerSelector(
    {
      view: record['view'],
      q: record['q'],
      ...(typeof filters === 'object' && filters !== null
        ? { filters: filters as Record<string, unknown> }
        : {}),
    },
    'payload.',
    'payload.filters.',
  );
  if (!selector.ok) return invalid(selector.error.path, selector.error.code);
  const order = parseSort(record['sort'], record['direction']);
  if (!order.ok) return invalid(`payload.${order.error.path}`, order.error.code);
  const canonicalFilters = filtersOf(selector.value);
  const defaultOrder = order.value.sort === 'joined' && order.value.direction === 'desc';
  return ok({
    v: 1,
    view: selector.value.view,
    ...(selector.value.text === null ? {} : { q: selector.value.text }),
    ...(Object.keys(canonicalFilters).length > 0 ? { filters: canonicalFilters } : {}),
    ...(defaultOrder ? {} : { sort: order.value.sort, direction: order.value.direction }),
  });
}

/**
 * The admin's list of seller attributions (phase 4a): view, the address prefix, the filters and
 * the direction (sorted by attribution instant only). Read with the list's own parser, so a saved
 * filter is exactly what the list accepts.
 */
function parseAttributionsPayload(
  value: unknown,
): Result<CustomerFilterPayload, ValidationFailure> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('payload', 'type');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PAYLOAD_KEYS.includes(key)) return invalid(`payload.${key}`, 'unknown');
  }
  if (record['v'] !== 1) return invalid('payload.v', 'value');
  if (record['sort'] !== undefined && record['sort'] !== 'attributed') {
    return invalid('payload.sort', 'value');
  }
  const direction = record['direction'];
  if (direction !== undefined && direction !== 'asc' && direction !== 'desc') {
    return invalid('payload.direction', 'value');
  }
  const selector = attributionSelectorOf({
    view: record['view'],
    q: record['q'],
    filters: record['filters'],
  });
  if (!selector.ok) {
    const failure = selector.error as ValidationFailure;
    const field = failure.fields?.[0] ?? { path: '', code: 'value' };
    return invalid(`payload.${field.path}`, field.code);
  }
  const chosen = selector.value;
  const filters: Record<string, string> = {};
  if (chosen.sellerId !== null) filters['sellerId'] = chosen.sellerId;
  if (chosen.status !== null) filters['status'] = chosen.status;
  if (chosen.rejectReason !== null) filters['rejectReason'] = chosen.rejectReason;
  if (chosen.flag !== null) filters['flag'] = chosen.flag;
  if (chosen.attributedFrom !== null) filters['attributedFrom'] = chosen.attributedFrom;
  if (chosen.attributedTo !== null) filters['attributedTo'] = chosen.attributedTo;
  return ok({
    v: 1,
    view: chosen.view,
    ...(chosen.emailPrefix === null ? {} : { q: chosen.emailPrefix }),
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
    ...(direction === 'asc' ? { sort: 'attributed', direction: 'asc' } : {}),
  });
}

const LISTS: readonly SavedFilterListDefinition[] = [
  {
    key: 'admin.customers.customers',
    population: 'admin',
    shareable: true,
    parsePayload: parseCustomersPayload,
  },
  {
    key: 'admin.customers.seller-attributions',
    population: 'admin',
    shareable: true,
    parsePayload: parseAttributionsPayload,
  },
];

/** The list a request names, or null for a key no list has. */
export function savedFilterListOf(key: unknown): SavedFilterListDefinition | null {
  return LISTS.find((list) => list.key === key) ?? null;
}
