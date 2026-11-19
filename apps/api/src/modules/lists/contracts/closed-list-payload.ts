import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { ListPayloadFailure } from './list-definition';

// A closed saved-filter document for a list whose panel saves a view, a few filter values, a sort
// and a direction (the same shape as the admin Sales lists of `ordering`, with `view` for `tab`):
// `{ v: 1, view, filters?, sort?, direction? }`. The owning module names the vocabulary; this file
// only reads the shape, so every list refuses an unknown key, a wrong type or an unknown word the
// same way. Search text, paging and ids are never part of a document.

/**
 * The relative date presets a panel resolves in the list's time zone when the filter is opened
 * (never a stored date). The same words as the admin Sales lists.
 */
export const SAVED_DATE_PRESETS = [
  'today',
  'yesterday',
  'last-7-days',
  'last-30-days',
  'this-month',
  'last-month',
] as const;

/** How one filter value is read: a word of a closed list, text of a bounded shape, or a flag. */
export type ClosedFilterRule =
  | { readonly kind: 'word'; readonly values: readonly string[] }
  /** The pattern must be anchored and bounded: it is the value's only size limit. */
  | { readonly kind: 'text'; readonly pattern: RegExp }
  /** `true` keeps the filter; `false` is the filter left out. */
  | { readonly kind: 'flag' };

export type ClosedFilterValue = string | true;

/** The canonical document: `v` and `view` always; the rest only when set. */
export interface ClosedListPayload {
  readonly v: 1;
  readonly view: string;
  readonly filters?: Readonly<Record<string, ClosedFilterValue>>;
  readonly sort?: string;
  readonly direction?: 'asc' | 'desc';
}

export interface ClosedListPayloadOptions {
  readonly views: readonly string[];
  /** The view of a document that names none. */
  readonly defaultView: string;
  /** The filters in their canonical order, each with its rule. */
  readonly filters: readonly (readonly [string, ClosedFilterRule])[];
  readonly sorts: readonly string[];
  /**
   * The rules across fields the list's own query would refuse (a filter that belongs to one view,
   * a range that ends before it starts). Runs on the canonical document; each problem is a
   * `payload.`-prefixed path and a code.
   */
  readonly check?: (
    payload: ClosedListPayload,
  ) => readonly { readonly path: string; readonly code: string }[];
}

const TOP_KEYS = ['v', 'view', 'filters', 'sort', 'direction'] as const;
const DIRECTIONS = ['asc', 'desc'] as const;

const refused = (path: string, code: string): Result<never, ListPayloadFailure> =>
  err({ code: 'validation.failed', fields: [{ path, code }] });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function word(
  value: unknown,
  allowed: readonly string[],
  path: string,
): Result<string, ListPayloadFailure> {
  if (typeof value !== 'string') return refused(path, 'type');
  const found = allowed.find((candidate) => candidate === value);
  return found === undefined ? refused(path, 'value') : ok(found);
}

function filterValue(
  value: unknown,
  rule: ClosedFilterRule,
  path: string,
): Result<ClosedFilterValue | null, ListPayloadFailure> {
  switch (rule.kind) {
    case 'word':
      return word(value, rule.values, path);
    case 'text':
      if (typeof value !== 'string') return refused(path, 'type');
      return rule.pattern.test(value) ? ok(value) : refused(path, 'format');
    case 'flag':
      if (typeof value !== 'boolean') return refused(path, 'type');
      return ok(value ? true : null);
  }
}

/**
 * The parser of a closed document. An empty entry (absent, null or '') is left out, so the stored
 * form is canonical and reading it again gives the same document.
 */
export function closedListPayloadParser(
  options: ClosedListPayloadOptions,
): (raw: unknown) => Result<ClosedListPayload, ListPayloadFailure> {
  const filterKeys = options.filters.map(([key]) => key);
  return (raw) => {
    if (!isRecord(raw)) return refused('payload', 'type');
    for (const key of Object.keys(raw)) {
      if (!(TOP_KEYS as readonly string[]).includes(key)) {
        return refused(`payload.${key}`, 'unknown');
      }
    }
    if (raw['v'] !== 1) return refused('payload.v', 'value');
    const view = word(raw['view'] ?? options.defaultView, options.views, 'payload.view');
    if (!view.ok) return view;

    const filters: Record<string, ClosedFilterValue> = {};
    const given = raw['filters'];
    if (given !== undefined && given !== null) {
      if (!isRecord(given)) return refused('payload.filters', 'type');
      for (const key of Object.keys(given)) {
        if (!filterKeys.includes(key)) return refused(`payload.filters.${key}`, 'unknown');
      }
      for (const [key, rule] of options.filters) {
        const entry = given[key];
        if (entry === undefined || entry === null || entry === '') continue;
        const found = filterValue(entry, rule, `payload.filters.${key}`);
        if (!found.ok) return found;
        if (found.value !== null) filters[key] = found.value;
      }
    }

    let sort: string | undefined;
    if (raw['sort'] !== undefined && raw['sort'] !== null) {
      const found = word(raw['sort'], options.sorts, 'payload.sort');
      if (!found.ok) return found;
      sort = found.value;
    }
    let direction: 'asc' | 'desc' | undefined;
    if (raw['direction'] !== undefined && raw['direction'] !== null) {
      const found = word(raw['direction'], DIRECTIONS, 'payload.direction');
      if (!found.ok) return found;
      direction = found.value === 'asc' ? 'asc' : 'desc';
    }

    const payload: ClosedListPayload = {
      v: 1,
      view: view.value,
      ...(Object.keys(filters).length > 0 ? { filters } : {}),
      ...(sort !== undefined ? { sort } : {}),
      ...(direction !== undefined ? { direction } : {}),
    };
    const problems = options.check?.(payload) ?? [];
    if (problems.length > 0) return err({ code: 'validation.failed', fields: problems });
    return ok(payload);
  };
}
