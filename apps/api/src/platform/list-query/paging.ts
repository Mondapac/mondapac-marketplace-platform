import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';

// The query contract of every super list (super list phase 0, B0-4): how a list reads its sort and
// its page, and how it answers. A module keeps its own search, filters and tabs; this file owns
// what is the same everywhere. Pure functions, no I/O.

/** A request the list does not accept: the field and the reason (the shape modules use). */
export interface ListQueryFailure {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

export const listQueryInvalid = (
  path: string,
  code: string,
): { ok: false; error: ListQueryFailure } => ({
  ok: false,
  error: { code: 'validation.failed', fields: [{ path, code }] },
});

/**
 * How a list pages, from the Market's "List paging" setting: `pages` is page numbers with the
 * total, `prev-next` is Previous and Next without a total (cheap on a large list).
 */
export const LIST_PAGING_MODES = ['pages', 'prev-next'] as const;
export type ListPagingMode = (typeof LIST_PAGING_MODES)[number];

/** Page numbers stop at this row; deeper rows are reached by narrowing the filter. */
export const MAX_PAGED_ROWS = 10_000;

export type SortDirection = 'asc' | 'desc';

export interface ListQuerySpec<S extends string> {
  readonly sorts: readonly S[];
  readonly defaultSort: S;
  /** The direction when none is given; default newest first (`desc`) but A to Z for `name`. */
  readonly defaultDirection?: (sort: S) => SortDirection;
  readonly defaultPageSize: number;
  readonly maxPageSize: number;
  /** The highest page number; pass `Math.ceil(MAX_PAGED_ROWS / pageSize)` bounds as needed. */
  readonly maxPage: number;
}

export interface ListQuery<S extends string> {
  readonly sort: S;
  readonly direction: SortDirection;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
}

const absent = (value: unknown): boolean => value === undefined || value === null || value === '';

function whole(
  path: string,
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): Result<number, ListQueryFailure> {
  if (absent(value)) return ok(fallback);
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? ok(value)
    : listQueryInvalid(path, 'range');
}

/**
 * The sort, direction, page, page size and paging mode of a closed record (`sort`, `direction`,
 * `page`, `pageSize`, `paging`). Each value is checked; absent ones take the spec's defaults, and
 * the paging mode defaults to `pages`. The panel reads the Market's "List paging" setting and sends
 * it as `paging`, so the server never guesses which mode the page shows.
 */
export function parseListQuery<S extends string>(
  record: Readonly<Record<string, unknown>>,
  spec: ListQuerySpec<S>,
): Result<ListQuery<S>, ListQueryFailure> {
  let sort = spec.defaultSort;
  if (!absent(record['sort'])) {
    const found = spec.sorts.find((candidate) => candidate === record['sort']);
    if (found === undefined) return listQueryInvalid('sort', 'value');
    sort = found;
  }
  let direction: SortDirection = spec.defaultDirection?.(sort) ?? 'desc';
  if (!absent(record['direction'])) {
    if (record['direction'] !== 'asc' && record['direction'] !== 'desc') {
      return listQueryInvalid('direction', 'value');
    }
    direction = record['direction'];
  }
  let paging: ListPagingMode = 'pages';
  if (!absent(record['paging'])) {
    const found = LIST_PAGING_MODES.find((candidate) => candidate === record['paging']);
    if (found === undefined) return listQueryInvalid('paging', 'value');
    paging = found;
  }
  const page = whole('page', record['page'], 1, 1, spec.maxPage);
  if (!page.ok) return page;
  const pageSize = whole('pageSize', record['pageSize'], spec.defaultPageSize, 1, spec.maxPageSize);
  if (!pageSize.ok) return pageSize;
  return ok({ sort, direction, page: page.value, pageSize: pageSize.value, paging });
}

/** The rows to read for a page: Previous and Next reads one extra row to know if a next page exists. */
export function pageWindow(query: Pick<ListQuery<string>, 'page' | 'pageSize' | 'paging'>): {
  readonly offset: number;
  readonly limit: number;
} {
  return {
    offset: (query.page - 1) * query.pageSize,
    limit: query.paging === 'pages' ? query.pageSize : query.pageSize + 1,
  };
}

export interface ListPage<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  /** Rows matching over all pages; null in `prev-next` mode (never counted). */
  readonly total: number | null;
  /** Whether a page after this one exists. */
  readonly hasNext: boolean;
}

/**
 * The answer of a page read with {@link pageWindow}: in `prev-next` mode the extra row is dropped
 * and tells `hasNext`, and no total is given; in `pages` mode `total` is the count.
 */
export function listPage<T>(
  rows: readonly T[],
  query: Pick<ListQuery<string>, 'page' | 'pageSize' | 'paging'>,
  total: number | null,
): ListPage<T> {
  const { page, pageSize, paging } = query;
  if (paging === 'pages') {
    const count = total ?? rows.length;
    return {
      items: rows,
      page,
      pageSize,
      paging,
      total: count,
      hasNext: page * pageSize < Math.min(count, MAX_PAGED_ROWS),
    };
  }
  return {
    items: rows.slice(0, pageSize),
    page,
    pageSize,
    paging,
    total: null,
    hasNext: rows.length > pageSize,
  };
}
