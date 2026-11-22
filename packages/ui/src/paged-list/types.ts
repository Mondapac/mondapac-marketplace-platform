// The shared parts of a page-numbered super list of the admin panel (Catalogue lists): the query,
// what the API answers (the list query contract of `platform/list-query`) and the list's config.

import type { ReactNode } from 'react';
import type { MenuItem, SuperColumn } from '../index.ts';

export type ListPagingMode = 'pages' | 'prev-next';
export type Direction = 'asc' | 'desc';

export const PAGE_SIZE = 25;
/** The API stops page numbers at 100 pages (`maxPage` of its list contract). */
export const MAX_PAGED_ROWS = 100 * PAGE_SIZE;

/** What a list asks for: its built-in tab, the search text, the filters, the sort and the page. */
export interface PagedQuery {
  readonly tab: string;
  readonly q: string;
  readonly filters: Readonly<Record<string, string>>;
  readonly sort: string;
  readonly direction: Direction;
  readonly page: number;
}

/** The answer of a list route that follows the list query contract. */
export interface PagedAnswer<Row> {
  readonly items: readonly Row[];
  /** Rows matching over all pages; null with Previous and next. */
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  readonly hasNext: boolean;
}

export interface PagedFilterField {
  readonly id: string;
  readonly label: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  /**
   * A date field: the options are presets ("Last 7 days"), the value kept in the filters is the
   * preset id, and the list route is asked for the instants it means as these two query keys
   * (`from` at or after, `to` before), read at each load by the list's `dateRange`.
   */
  readonly range?: { readonly from: string; readonly to: string };
}

/** The instants a date preset means: `from` at or after, `to` before (ISO 8601 with an offset). */
export interface PagedInstantRange {
  readonly from: string;
  readonly to: string;
}

/** What turns a date field's preset id into instants; null when it cannot (the filter is left out). */
export interface PagedDateRanges {
  readonly fields: readonly PagedFilterField[];
  readonly resolve: (preset: string) => PagedInstantRange | null;
}

export interface PagedBulkAction<Row> {
  readonly id: string;
  readonly label: string;
  readonly run: (rows: readonly Row[]) => void;
}

export interface PagedSort {
  readonly id: string;
  /** "Newest first" and "Oldest first" (the first reads for the default direction). */
  readonly orders: readonly [string, string];
  readonly defaultDirection: Direction;
}

/**
 * What one list is, in words and in code. Every word the shared list shows comes from `ns` (one
 * i18n namespace per list, keys listed in `paged-super-list.tsx`); the list itself only says which
 * route it reads, which tabs, filters, sorts and columns it has and what a row offers.
 */
export interface PagedListConfig<Row> {
  readonly ns: string;
  /** The list route, for example `catalog/admin/variants`. */
  readonly endpoint: string;
  /** The export route and the file name stem; absent when the list has no export yet. */
  readonly exportEndpoint?: string;
  readonly exportName?: string;
  /** The export route takes `sort` and `direction` and writes the file in the list's order. */
  readonly exportKeepsSort?: boolean;
  readonly rowId: (row: Row) => string;
  readonly rowName: (row: Row) => string;
  /** Built-in tabs, the first is "all". */
  readonly tabs: readonly string[];
  /** The query parameter a tab other than the first sets to its id (for example `issue`). */
  readonly tabParam?: string;
  /** Query parameters of a tab when one id is not enough (`status=draft`); sent for every tab. */
  readonly tabParams?: (tab: string) => Readonly<Record<string, string | undefined>>;
  /** Absent when the route has no text search (the review queue). */
  readonly search?: {
    readonly max: number;
    /** The query key the route reads (default `q`). */ readonly param?: string;
    /**
     * Text the route can take (an exact id). Other text is not searched; the list says
     * `search.invalid` instead of asking the route.
     */
    readonly accepts?: (text: string) => boolean;
  };
  readonly sorts: readonly PagedSort[];
  readonly defaultSort: string;
  /** Columns always shown (the first is the card's title) and the ones an admin can hide. */
  readonly fixedColumns: readonly string[];
  readonly optionalColumns: readonly string[];
  readonly defaultColumns: readonly string[];
  readonly columnDefs: (id: string, header: string) => SuperColumn<Row>;
  readonly rowActions: (row: Row) => readonly MenuItem[];
  /**
   * Bulk decisions of a queue (accept, reject): each is in the Bulk action menu, on only while rows
   * of this page are ticked, and runs on those rows (never on "all matching").
   */
  readonly bulk?: readonly PagedBulkAction<Row>[];
  /** No row selection, no Bulk action menu and no row Actions (a seller's own read-only list). */
  readonly readOnly?: boolean;
  readonly icon?: 'package' | 'search' | 'columns';
  /**
   * The list's key in the shared saved-filter registry (`lists`): present, the list has saved
   * personal and shared filters as tabs after the built-in ones (it also needs `csrfToken` and the
   * runtime's `savedFiltersPath`). A saved filter holds the search, the filters (the built-in tab's
   * own query parameters included, as the route's payload has no views) and the sort.
   */
  readonly savedKey?: string;
  /**
   * The list's saved payload has a `view` (the registry list declares its views): the built-in tab
   * is saved as `view` and its own query parameters stay out of `filters`. Default: no views, the
   * tab is saved as the parameters it sets.
   */
  readonly savedViews?: boolean;
  /**
   * Whether a saved filter belongs on this list when several lists share one key (the Product
   * review queue and the Revision queue are told apart by `kind`). Default: every one fits.
   */
  readonly savedFits?: (
    filters: Readonly<Record<string, string>>,
    /** The whole document (its `view` too, for a list with `savedViews`). */
    payload: { readonly view?: string; readonly filters: Readonly<Record<string, string>> },
  ) => boolean;
}

export const DEFAULT_PAGED_QUERY = (config: {
  readonly defaultSort: string;
  readonly sorts: readonly PagedSort[];
  readonly tabs: readonly string[];
}): PagedQuery => ({
  tab: config.tabs[0] ?? 'all',
  q: '',
  filters: {},
  sort: config.defaultSort,
  direction: config.sorts.find((sort) => sort.id === config.defaultSort)?.defaultDirection ?? 'asc',
  page: 1,
});

export type { ReactNode };

/** A translator as the panel's i18n gives it: a key with values, and `has` for optional keys. */
export interface PagedTranslator {
  (key: string, values?: Record<string, string | number>): string;
  has(key: string): boolean;
}

/** What the panel hands the list: its translations, its locale and its same-origin relay call. */
export interface PagedListRuntime {
  readonly useTranslations: (namespace: string) => PagedTranslator;
  readonly useLocale: () => string;
  /** The generic saved-filter routes of the panel's population (`lists/admin/saved-filters`). */
  readonly savedFiltersPath?: string;
  readonly callApi: <T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    csrfToken?: string,
  ) => Promise<
    | { readonly ok: true; readonly status: number; readonly body: T }
    | {
        readonly ok: false;
        readonly failure: {
          readonly status: number;
          readonly code: string;
          readonly details?: { readonly max?: number };
        };
      }
  >;
}
