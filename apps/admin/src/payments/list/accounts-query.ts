// The query string of the Seller accounts list: what the view, search, filters, sort and page ask
// GET payments/admin/connected-accounts for. Both List paging modes send the page and the sort
// (Previous and next only gets no total and no counts back).

import type { ListPagingMode } from '../../sales/cursor-paging.ts';
import { presetRange } from '../../sales/date-presets.ts';
import { isUuid } from '../../sales/search-route.ts';
import { SEARCH_MAX, SEARCH_MIN, type Query } from './accounts-list-types.ts';

/** One box, one API key (`q`): a full seller id, or 2 to 80 characters of a store name. */
export type AccountSearch =
  | { readonly kind: 'none' }
  | { readonly kind: 'too-short' }
  | { readonly kind: 'id'; readonly value: string }
  | { readonly kind: 'store'; readonly value: string };

export function accountSearchRoute(text: string): AccountSearch {
  // A pasted tab or line break is a space: the API (and the BFF's value check) take printable text.
  // eslint-disable-next-line no-control-regex
  const value = Array.from(text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim())
    .slice(0, SEARCH_MAX)
    .join('');
  if (value === '') return { kind: 'none' };
  if (isUuid(value)) return { kind: 'id', value: value.toLowerCase() };
  if (Array.from(value).length < SEARCH_MIN) return { kind: 'too-short' };
  return { kind: 'store', value };
}

export interface QueryContext {
  readonly paging: ListPagingMode;
  /** The IANA zone of the table's times; the date presets are read on its clock (ADR-0005). */
  readonly zone: string;
  readonly now: Date;
}

/** The keys that choose which rows the list holds (an export of "all matching" sends these). */
export function selectorParams(query: Query, context: QueryContext): URLSearchParams {
  const params = new URLSearchParams();
  if (query.view !== 'all') params.set('status', query.view);
  const route = accountSearchRoute(query.q);
  if (route.kind === 'id' || route.kind === 'store') params.set('q', route.value);
  const { filters } = query;
  if (filters.ready !== undefined) params.set('ready', filters.ready);
  if (filters.requirements !== undefined) params.set('requirements', filters.requirements);
  if (filters.waiting !== undefined) params.set('waiting', filters.waiting);
  if (filters.created !== undefined) {
    const range = presetRange(filters.created, context.zone, context.now);
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
