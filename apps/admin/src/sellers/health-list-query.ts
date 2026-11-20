// The query of the "Needs a look" super list: the page's own state, and the request it makes (the
// list route and the export take the same keys; the API validates).

import { cleanColumnIds } from '../sales/columns.ts';
import type { Direction, Sort, View } from './health-types.ts';

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 100;
export const PAGE_SIZES = [25, 50, 100] as const;
/** The queue holds at most 200 sellers, so that is also the most rows one export can tick. */
export const SELECT_MAX = 200;
/** The API stops page numbers at this row. */
export const MAX_PAGED_ROWS = 10_000;

export const FILTER_FIELDS = ['minScore', 'maxScore'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];
/** A filter that is not set is left out; the values are whole numbers from 0 to 100, as digits. */
export type Filters = Partial<Record<FilterField, string>>;

export interface Query {
  readonly view: View;
  readonly q: string;
  readonly filters: Filters;
  readonly sort: Sort;
  readonly direction: Direction;
  readonly page: number;
  readonly pageSize: number;
}

/** Worst score first: the queue's own order. */
export const DEFAULT_QUERY: Query = {
  view: 'all',
  q: '',
  filters: {},
  sort: 'score',
  direction: 'asc',
  page: 1,
  pageSize: PAGE_SIZES[0],
};

/** The score worst (lowest) first and names A to Z; the measured day newest first. */
export const defaultDirection = (sort: Sort): Direction => (sort === 'day' ? 'desc' : 'asc');

const SCORE = /^(100|[1-9]?[0-9])$/;
export const isScore = (value: string): boolean => SCORE.test(value);

/** A search shorter than the API takes is not sent (the box says why). */
export const searchOf = (q: string): string | undefined => {
  const text = q.trim();
  return text.length >= SEARCH_MIN ? text : undefined;
};

export const filterCount = (filters: Filters): number =>
  FILTER_FIELDS.filter((field) => filters[field] !== undefined).length;

/** The selector keys of the list and of an export: the view, the search and the score range. */
export function selectorParams(query: Query): URLSearchParams {
  const params = new URLSearchParams();
  if (query.view !== 'all') params.set('view', query.view);
  const q = searchOf(query.q);
  if (q !== undefined) params.set('q', q);
  for (const field of FILTER_FIELDS) {
    const value = query.filters[field];
    if (value !== undefined) params.set(field, value);
  }
  return params;
}

/** The list request: the selector, the sort, the Market's paging mode and the page. */
export function queryString(query: Query, paging: 'pages' | 'prev-next'): string {
  const params = selectorParams(query);
  params.set('sort', query.sort);
  params.set('direction', query.direction);
  params.set('paging', paging);
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  return params.toString();
}

/** The columns an admin can hide, show and reorder; the seller column is always shown. */
export const OPTIONAL_COLUMNS = ['score', 'lowest', 'measured', 'seller-id'] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];
export const DEFAULT_COLUMNS: readonly OptionalColumn[] = ['score', 'lowest', 'measured'];

export const cleanColumns = (saved: readonly unknown[] | undefined): readonly OptionalColumn[] =>
  cleanColumnIds(saved, OPTIONAL_COLUMNS, DEFAULT_COLUMNS);

/**
 * The optional columns of an export, as the API names them: it always writes the store, slug,
 * score and lowest measure, and adds the seller id and the measured day when shown, in the shown
 * order.
 */
export function exportColumnIds(columns: readonly OptionalColumn[]): readonly string[] {
  return columns.flatMap((column) =>
    column === 'seller-id' ? ['seller-id'] : column === 'measured' ? ['day'] : [],
  );
}
