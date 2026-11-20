// The query, columns and saved-filter document of the Issuer requests super list (GET
// certification/admin/issuer-requests/list and .../export). Pure, so each rule is tested alone.

import { cleanColumnIds } from '../../sales/columns.ts';
import { isDatePreset, presetRange, type DatePreset } from '../../sales/date-presets.ts';
import { toId } from '../../sales/search-route.ts';

export type ListPagingMode = 'pages' | 'prev-next';

/** The list has one built-in view; the API accepts `all` only. */
export const VIEWS = ['all'] as const;
export type View = (typeof VIEWS)[number];

export const SORTS = ['submitted', 'type'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';

export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;
/** The most requests one export names by id (the API's limit). */
export const SELECTION_MAX = 200;
/** What the list reads at most; past it the newest open requests are not listed. */
export const READ_CAP = 500;
/** The rows past which the API refuses a page. */
export const MAX_LIST_ROWS = 10_000;
export const SEARCH_MAX = 36;

/** The certification type codes the API accepts in `type`. */
export const TYPE_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const FILTER_FIELDS = ['type', 'submitted'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

export interface Filters {
  readonly type?: string;
  readonly submitted?: DatePreset;
}

export const filterCount = (filters: Filters): number => Object.keys(filters).length;

/** The filters a panel answer holds: only a known value of a known field. */
export function filtersOf(values: Readonly<Record<string, string>>): Filters {
  const next: { type?: string; submitted?: DatePreset } = {};
  const type = values['type'];
  if (type !== undefined && TYPE_CODE.test(type)) next.type = type;
  const submitted = values['submitted'];
  if (isDatePreset(submitted)) next.submitted = submitted;
  return next;
}

export interface Query {
  readonly view: View;
  /** What was typed, trimmed: a request id, or nothing. */
  readonly q: string;
  readonly filters: Filters;
  /** One seller's requests, from a link (`?sellerId=`); the panel has no picker for it. */
  readonly sellerId: string | null;
  readonly sort: Sort;
  readonly direction: Direction;
  readonly page: number;
  readonly pageSize: number;
}

export const DEFAULT_QUERY: Query = {
  view: 'all',
  q: '',
  filters: {},
  sellerId: null,
  // Oldest request first: the queue's order stays the default.
  sort: 'submitted',
  direction: 'asc',
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

/** Both sorts read best in ascending order first: oldest first, A to Z. */
export const defaultDirection = (): Direction => 'asc';

/** The message key of a direction: `submitted.first` is oldest first, `type.first` A to Z. */
export const orderKey = (sort: Sort, direction: Direction): string =>
  `${sort}.${direction === defaultDirection() ? 'first' : 'second'}`;

/** The id the search box means (a request id, any case), or null for any other text. */
export const requestIdOf = (text: string): string | null => toId(text.trim());

export interface QueryContext {
  readonly paging: ListPagingMode;
  /** The IANA zone of the table's times; the date presets are read on its clock (ADR-0005). */
  readonly zone: string;
  readonly now: Date;
}

/** The selector keys of the list, shared by the list and its export. */
function selectorParams(query: Query, context: QueryContext): URLSearchParams {
  const params = new URLSearchParams();
  const { filters } = query;
  if (filters.type !== undefined) params.set('type', filters.type);
  const id = requestIdOf(query.q);
  if (id !== null) params.set('q', id);
  if (query.sellerId !== null) params.set('sellerId', query.sellerId);
  if (filters.submitted !== undefined) {
    const range = presetRange(filters.submitted, context.zone, context.now);
    if (range !== null) {
      params.set('from', range.from);
      params.set('to', range.to);
    }
  }
  return params;
}

export function queryString(query: Query, context: QueryContext): string {
  const params = selectorParams(query, context);
  params.set('sort', query.sort);
  params.set('direction', query.direction);
  params.set('paging', context.paging);
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  return params.toString();
}

// --- columns ------------------------------------------------------------------------------------

/** The columns an admin can hide, show and reorder; the ids are the ones the export reads. */
export const OPTIONAL_COLUMNS = ['documents', 'request-id', 'seller-id'] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];
export const DEFAULT_COLUMNS: readonly OptionalColumn[] = ['documents'];

export const cleanColumns = (saved: readonly unknown[] | undefined): readonly OptionalColumn[] =>
  cleanColumnIds(saved, OPTIONAL_COLUMNS, DEFAULT_COLUMNS);

// --- export -------------------------------------------------------------------------------------

/** The rows the Bulk action menu acts on: the ticked ones, or, after "Select all", the filter. */
export interface ExportSelection {
  readonly ids: readonly string[];
  readonly allMatching: boolean;
  /** Rows the filter matches; null with Previous and next. */
  readonly total: number | null;
}

/**
 * The query of the export. Ticked rows are the whole selection (`ids`: the API refuses a filter or
 * a sort beside them); with "Select all matching" the list's selector keys and its sort say which
 * rows, in which order. `columns` are the optional columns shown, in the shown order (type, store
 * and submitted are always in the file).
 */
export function exportQuery(input: {
  readonly query: Query;
  readonly context: QueryContext;
  readonly format: 'csv' | 'xlsx';
  readonly columns: readonly OptionalColumn[];
  readonly selection: ExportSelection;
}): string {
  const { selection } = input;
  const params = new URLSearchParams();
  if (selection.allMatching) {
    for (const [key, value] of selectorParams(input.query, input.context)) params.set(key, value);
    params.set('sort', input.query.sort);
    params.set('direction', input.query.direction);
  } else {
    // Nothing ticked and "Select all matching" off names no rows; the menu item is disabled then.
    if (selection.ids.length === 0) throw new Error('export.no-rows-selected');
    params.set('ids', selection.ids.join(','));
  }
  params.set('format', input.format);
  params.set('columns', input.columns.join(','));
  return params.toString();
}

// --- saved filters ------------------------------------------------------------------------------

export const LIST_KEY = 'admin.certification.issuer-requests';

/** The document a saved filter keeps; keys the page did not change are left out. */
export interface SavedPayload {
  readonly v: 1;
  readonly view: View;
  readonly filters?: Filters;
  readonly sort?: Sort;
  readonly direction?: Direction;
}

export function somethingToSave(query: Query): boolean {
  return (
    Object.keys(query.filters).length > 0 ||
    query.sort !== DEFAULT_QUERY.sort ||
    query.direction !== DEFAULT_QUERY.direction
  );
}

export function payloadOf(query: Query): SavedPayload {
  const filters = filtersOf(query.filters as Readonly<Record<string, string>>);
  return {
    v: 1,
    view: query.view,
    ...(Object.keys(filters).length === 0 ? {} : { filters }),
    ...(query.sort !== DEFAULT_QUERY.sort ? { sort: query.sort } : {}),
    ...(query.direction !== DEFAULT_QUERY.direction ? { direction: query.direction } : {}),
  };
}

/** The query a saved filter opens, on its first page; a value the page does not know is dropped. */
export function queryOf(payload: SavedPayload, pageSize: number): Query {
  const raw: unknown = payload.filters;
  const strings =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? Object.fromEntries(
          Object.entries(raw).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : {};
  return {
    ...DEFAULT_QUERY,
    pageSize,
    filters: filtersOf(strings),
    sort: SORTS.find((value) => value === payload.sort) ?? DEFAULT_QUERY.sort,
    direction:
      payload.direction === 'asc' || payload.direction === 'desc'
        ? payload.direction
        : DEFAULT_QUERY.direction,
  };
}
