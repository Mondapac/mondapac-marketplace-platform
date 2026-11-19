import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { ListDefinition, ListPayloadFailure } from '../../lists';
import {
  SYSTEM_REQUESTS_REQUEST_VIEW,
  SYSTEM_REQUESTS_SAVED_FILTER_SHARE,
} from '../contracts/permissions';
import { REVIEW_AREAS, RISKS } from '../domain/areas';
import { REQUEST_STATUSES, REQUEST_VIEWS } from '../domain/request';
import { REQUEST_SORTS } from './ports/request.repository';

// The saved filters of the System requests queue (CLAUDE.md rule 14), through the generic routes
// of `lists` (`lists/admin/saved-filters`, ADR-0049 B0-1b). This module keeps the meaning of a
// saved filter's document and the keys that guard the queue; `lists` keeps the table, the caps,
// the names and the sharing rules. The document is closed: the view, the area, risk and status
// values, the applied days, "overdue only", the sort and its direction. The search text and the
// deep-link subject (a setting page's banner) are never saved.

export const SYSTEM_REQUESTS_LIST_KEY = 'admin.system-requests.requests';

/** The closed document of a saved filter, in its canonical form (an empty part is left out). */
export interface RequestFilterPayload {
  readonly v: 1;
  readonly view: (typeof REQUEST_VIEWS)[number];
  readonly filters?: {
    readonly area?: readonly string[];
    readonly risk?: readonly string[];
    readonly status?: readonly string[];
    /** Calendar days (`YYYY-MM-DD`) on the admin's clock; the panel turns them into instants. */
    readonly from?: string;
    readonly to?: string;
    readonly overdue?: true;
  };
  readonly sort?: (typeof REQUEST_SORTS)[number];
  readonly direction?: 'asc' | 'desc';
}

const TOP_KEYS = ['v', 'view', 'filters', 'sort', 'direction'] as const;
const FILTER_KEYS = ['area', 'risk', 'status', 'from', 'to', 'overdue'] as const;
const LIST_FILTERS: Readonly<Record<'area' | 'risk' | 'status', readonly string[]>> = {
  area: REVIEW_AREAS,
  risk: RISKS,
  status: REQUEST_STATUSES,
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day: 2026-02-31 is refused, not rolled over to March. */
const isDay = (value: unknown): value is string => {
  if (typeof value !== 'string' || !DAY.test(value)) return false;
  try {
    Temporal.PlainDate.from(value, { overflow: 'reject' });
    return true;
  } catch {
    return false;
  }
};

const invalid = (path: string, code: string): { ok: false; error: ListPayloadFailure } =>
  err({ code: 'validation.failed', fields: [{ path, code }] }) as {
    ok: false;
    error: ListPayloadFailure;
  };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A list of words of `allowed`, kept in the vocabulary's order, each once; empty is left out. */
function wordsOf(
  value: unknown,
  allowed: readonly string[],
  path: string,
): Result<readonly string[] | undefined, ListPayloadFailure> {
  if (value === undefined || value === null) return ok(undefined);
  if (!Array.isArray(value) || value.length > allowed.length * 2) return invalid(path, 'type');
  for (const entry of value) {
    if (typeof entry !== 'string' || !allowed.includes(entry)) return invalid(path, 'value');
  }
  const chosen = allowed.filter((word) => (value as readonly unknown[]).includes(word));
  return ok(chosen.length === 0 ? undefined : chosen);
}

/**
 * Reads a saved filter's document and returns its canonical form, or the first field it refuses
 * (`payload.<path>`, `unknown`, `type` or `value`). An end day before the start day is refused:
 * the queue itself refuses that range.
 */
export function parseRequestFilterPayload(
  raw: unknown,
): Result<RequestFilterPayload, ListPayloadFailure> {
  if (!isRecord(raw)) return invalid('payload', 'type');
  for (const key of Object.keys(raw)) {
    if (!(TOP_KEYS as readonly string[]).includes(key)) return invalid(`payload.${key}`, 'unknown');
  }
  if (raw['v'] !== 1) return invalid('payload.v', 'value');
  const view = raw['view'];
  if (typeof view !== 'string') return invalid('payload.view', 'type');
  const knownView = REQUEST_VIEWS.find((candidate) => candidate === view);
  if (knownView === undefined) return invalid('payload.view', 'value');

  const filters: {
    area?: readonly string[];
    risk?: readonly string[];
    status?: readonly string[];
    from?: string;
    to?: string;
    overdue?: true;
  } = {};
  const given = raw['filters'];
  if (given !== undefined && given !== null) {
    if (!isRecord(given)) return invalid('payload.filters', 'type');
    for (const key of Object.keys(given)) {
      if (!(FILTER_KEYS as readonly string[]).includes(key)) {
        return invalid(`payload.filters.${key}`, 'unknown');
      }
    }
    for (const field of ['area', 'risk', 'status'] as const) {
      const words = wordsOf(given[field], LIST_FILTERS[field], `payload.filters.${field}`);
      if (!words.ok) return words;
      if (words.value !== undefined) filters[field] = words.value;
    }
    for (const field of ['from', 'to'] as const) {
      const day = given[field];
      if (day === undefined || day === null || day === '') continue;
      if (!isDay(day)) return invalid(`payload.filters.${field}`, 'value');
      filters[field] = day;
    }
    if (filters.from !== undefined && filters.to !== undefined && filters.to < filters.from) {
      return invalid('payload.filters.to', 'value');
    }
    const overdue = given['overdue'];
    if (overdue !== undefined && overdue !== null && overdue !== false) {
      if (overdue !== true) return invalid('payload.filters.overdue', 'value');
      filters.overdue = true;
    }
  }

  const sort = raw['sort'];
  let knownSort: (typeof REQUEST_SORTS)[number] | undefined;
  if (sort !== undefined && sort !== null) {
    knownSort = REQUEST_SORTS.find((candidate) => candidate === sort);
    if (knownSort === undefined) return invalid('payload.sort', 'value');
  }
  const direction = raw['direction'];
  if (
    direction !== undefined &&
    direction !== null &&
    direction !== 'asc' &&
    direction !== 'desc'
  ) {
    return invalid('payload.direction', 'value');
  }

  const ordered = Object.fromEntries(
    FILTER_KEYS.flatMap((key) => (filters[key] === undefined ? [] : [[key, filters[key]]])),
  ) as RequestFilterPayload['filters'];
  return ok({
    v: 1,
    view: knownView,
    ...(Object.keys(ordered ?? {}).length === 0 ? {} : { filters: ordered }),
    ...(knownSort === undefined ? {} : { sort: knownSort }),
    ...(direction === 'asc' || direction === 'desc' ? { direction } : {}),
  });
}

/**
 * The lists system-requests registers with `lists` (`registerLists('system-requests', ...)`):
 * the queue, guarded by its own view key; sharing a filter needs the module's share key.
 */
export const SYSTEM_REQUESTS_LISTS: readonly ListDefinition[] = [
  {
    listKey: SYSTEM_REQUESTS_LIST_KEY,
    population: 'admin',
    viewKey: SYSTEM_REQUESTS_REQUEST_VIEW.key,
    shareKey: SYSTEM_REQUESTS_SAVED_FILTER_SHARE.key,
    parsePayload: (raw) => parseRequestFilterPayload(raw),
  },
];
