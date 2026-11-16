import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { ListPayloadFailure } from './list-definition';

// The saved document of a super list that reads a plain query (view, `q`, filter keys, sort and
// direction; super list phase 4, PR10): one closed, versioned shape for every such list, so a
// module states only its vocabulary and hands the selector keys to the list's own query reader.
// What the list refuses is refused here, under the payload's path; what it accepts is stored in
// its canonical form. Paging and columns are not part of a saved filter.

/** A field the list's own reader refused, keyed as in the list's query. */
export interface ListQueryField {
  readonly path: string;
  readonly code: string;
}

/** The saved document: `view` only for a list with views, `q` only when it was given. */
export interface SavedListPayload {
  readonly v: 1;
  readonly view?: string;
  readonly q?: string;
  readonly filters: Readonly<Record<string, string>>;
  readonly sort: string;
  readonly direction: 'asc' | 'desc';
}

export interface SavedListPayloadSpec {
  /** The views (tabs) of the list; null when it has none, and `view` is then an unknown key. */
  readonly views: readonly string[] | null;
  /** The filter keys of the list's query a saved filter may hold (never paging keys). */
  readonly filterKeys: readonly string[];
  /** The sort keys the list accepts. */
  readonly sorts: readonly string[];
  /**
   * The list's own reading of the selector keys (`view`, `q` and the filter keys, as query
   * strings): the fields it refuses, and the canonical text of every key it accepted (a key left
   * out of `canonical` is not stored).
   */
  read(query: Readonly<Record<string, string>>): {
    readonly fields: readonly ListQueryField[];
    readonly canonical: Readonly<Record<string, string>>;
  };
}

const PAYLOAD_KEYS = ['v', 'view', 'q', 'filters', 'sort', 'direction'] as const;

const refuse = (path: string, code: string): Result<never, ListPayloadFailure> =>
  err({ code: 'validation.failed', fields: [{ path, code }] });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The payload parser of a list, for its `ListDefinition.parsePayload`. */
export function savedListPayloadParser(
  spec: SavedListPayloadSpec,
): (raw: unknown) => Result<SavedListPayload, ListPayloadFailure> {
  const filterKeys = new Set(spec.filterKeys);
  const pathOf = (key: string) =>
    filterKeys.has(key) ? `payload.filters.${key}` : `payload.${key}`;
  return (raw) => {
    if (!isRecord(raw)) return refuse('payload', 'type');
    for (const key of Object.keys(raw)) {
      const known = (PAYLOAD_KEYS as readonly string[]).includes(key);
      if (!known || (key === 'view' && spec.views === null))
        return refuse(`payload.${key}`, 'unknown');
    }
    if (raw['v'] !== 1) return refuse('payload.v', 'value');
    const required = spec.views === null ? ['sort', 'direction'] : ['view', 'sort', 'direction'];
    for (const key of required)
      if (raw[key] === undefined) return refuse(`payload.${key}`, 'required');

    const query: Record<string, string> = {};
    if (spec.views !== null) {
      const view = raw['view'];
      if (typeof view !== 'string') return refuse('payload.view', 'type');
      if (!spec.views.includes(view)) return refuse('payload.view', 'value');
      query['view'] = view;
    }
    const q = raw['q'];
    if (q !== undefined && q !== null) {
      if (typeof q !== 'string') return refuse('payload.q', 'type');
      if (q !== '') query['q'] = q;
    }
    const filtersRaw = raw['filters'] ?? {};
    if (!isRecord(filtersRaw)) return refuse('payload.filters', 'type');
    for (const key of Object.keys(filtersRaw)) {
      if (!filterKeys.has(key)) return refuse(`payload.filters.${key}`, 'unknown');
    }
    for (const key of spec.filterKeys) {
      const value = filtersRaw[key];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'string') return refuse(`payload.filters.${key}`, 'type');
      query[key] = value;
    }

    const read = spec.read(query);
    const first = read.fields[0];
    if (first !== undefined) {
      return err({
        code: 'validation.failed',
        fields: read.fields.map((field) => ({ path: pathOf(field.path), code: field.code })),
      });
    }
    const sort = spec.sorts.find((candidate) => candidate === raw['sort']);
    if (sort === undefined) return refuse('payload.sort', 'value');
    const direction = raw['direction'];
    if (direction !== 'asc' && direction !== 'desc') return refuse('payload.direction', 'value');

    const filters: Record<string, string> = {};
    for (const key of spec.filterKeys) {
      const value = read.canonical[key];
      if (value !== undefined) filters[key] = value;
    }
    const canonicalQ = read.canonical['q'];
    return ok({
      v: 1,
      ...(spec.views === null ? {} : { view: query['view']! }),
      ...(canonicalQ === undefined ? {} : { q: canonicalQ }),
      filters,
      sort,
      direction,
    });
  };
}

/**
 * The canonical texts of the values a list's reader accepted, for `read`: each value's own text
 * (an id, a code, an instant's ISO text, minor units as digits); a null one is left out.
 */
export function canonicalQuery(
  values: Readonly<Record<string, { toString(): string } | null>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== null) out[key] = value.toString();
  }
  return out;
}
