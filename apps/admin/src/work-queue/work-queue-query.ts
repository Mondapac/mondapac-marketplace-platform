// The query of the full work-queue page: one row per queue, read once by the page (at most about
// twenty rows), so the views, search, filters and sort run in the browser on those rows.

import { needsAction, workQueueStatus, type WorkQueueLevel, type WorkQueueRow } from '@mondapac/ui';

export const VIEWS = ['needs-action', 'all', 'critical', 'today', 'review'] as const;
export type View = (typeof VIEWS)[number];

export const SORTS = ['age', 'overdue', 'count', 'name'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';

export const FILTER_FIELDS = ['state'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];
export const STATES = ['overdue', 'waiting', 'clear', 'error'] as const;
export type QueueState = (typeof STATES)[number];
export type Filters = Partial<Record<FilterField, QueueState>>;

export const OPTIONAL_COLUMNS = ['level', 'count', 'overdue', 'oldest', 'status'] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];
export const DEFAULT_COLUMNS: readonly OptionalColumn[] = OPTIONAL_COLUMNS;

export const SEARCH_MAX = 100;

export interface Query {
  readonly view: View;
  readonly q: string;
  readonly filters: Filters;
  readonly sort: Sort;
  readonly direction: Direction;
  /** Always 1: the rows fit on one page (the kit hook needs the field). */
  readonly page: number;
}

/** Oldest first: the design's order of the full page (design section 6). */
export const DEFAULT_QUERY: Query = {
  view: 'needs-action',
  q: '',
  filters: {},
  sort: 'age',
  direction: 'asc',
  page: 1,
};

export const isView = (value: unknown): value is View =>
  typeof value === 'string' && (VIEWS as readonly string[]).includes(value);

/** Age: oldest first; counts: most first; name: A to Z. */
export const defaultDirection = (sort: Sort): Direction =>
  sort === 'age' || sort === 'name' ? 'asc' : 'desc';

export function cleanColumns(
  value: readonly string[] | null | undefined,
): readonly OptionalColumn[] {
  if (value === null || value === undefined) return DEFAULT_COLUMNS;
  return OPTIONAL_COLUMNS.filter((column) => value.includes(column)).sort(
    (a, b) => value.indexOf(a) - value.indexOf(b),
  );
}

/** The state a row's filter matches. */
export function stateOf(row: WorkQueueRow, now: number): QueueState {
  const status = workQueueStatus(row, now);
  if (status.kind === 'error') return 'error';
  if (status.kind === 'clear') return 'clear';
  return status.kind === 'overdue' || status.kind === 'incident' || status.kind === 'fix'
    ? 'overdue'
    : 'waiting';
}

export function inView(row: WorkQueueRow, view: View): boolean {
  if (view === 'all') return true;
  if (view === 'needs-action') return needsAction(row);
  return row.level === (view satisfies WorkQueueLevel);
}

const oldest = (row: WorkQueueRow): number => {
  if (row.state.kind !== 'ok' || row.state.oldestAt === null) return Number.NaN;
  return Date.parse(row.state.oldestAt);
};

/**
 * The rows of the query, in its order. A row without an age (empty, or not read) goes last in
 * either direction, and a row that could not be read has no count to sort by.
 */
export function applyQuery(
  rows: readonly WorkQueueRow[],
  query: Query,
  now: number,
  locale: string,
): WorkQueueRow[] {
  const q = query.q.trim().toLocaleLowerCase(locale);
  const state = query.filters.state;
  const kept = rows.filter(
    (row) =>
      inView(row, query.view) &&
      (q === '' || row.label.toLocaleLowerCase(locale).includes(q)) &&
      (state === undefined || stateOf(row, now) === state),
  );
  const sign = query.direction === 'asc' ? 1 : -1;
  const value = (row: WorkQueueRow): number => {
    if (query.sort === 'age') return oldest(row);
    if (row.state.kind !== 'ok') return Number.NaN;
    return query.sort === 'count' ? row.state.count : row.state.overdue;
  };
  return kept
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (query.sort === 'name') {
        return sign * a.row.label.localeCompare(b.row.label, locale) || a.index - b.index;
      }
      const va = value(a.row);
      const vb = value(b.row);
      const na = Number.isNaN(va);
      const nb = Number.isNaN(vb);
      if (na || nb) return na === nb ? a.index - b.index : na ? 1 : -1;
      return sign * (va - vb) || a.index - b.index;
    })
    .map(({ row }) => row);
}

export function viewCounts(rows: readonly WorkQueueRow[]): Record<View, number> {
  return Object.fromEntries(
    VIEWS.map((view) => [view, rows.filter((row) => inView(row, view)).length]),
  ) as Record<View, number>;
}
