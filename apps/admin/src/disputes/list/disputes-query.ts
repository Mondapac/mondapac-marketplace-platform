// The query string of the Disputes list: what the view, search, filters, sort and page ask
// GET commission-payouts/admin/disputes for. Page numbers (List paging `pages`) send `page`,
// `pageSize`, `sort` and `direction`; Previous and next sends `limit` and `cursor` only, newest
// first (the API refuses a sort beside a cursor).

import type { ListPagingMode } from '../../sales/cursor-paging.ts';
import { presetRange } from '../../sales/date-presets.ts';
import { isUuid } from '../../sales/search-route.ts';
import { SEARCH_MAX, SEARCH_MIN, dueBeforeOf, type Query } from './disputes-list-types.ts';

/**
 * The one search box fills one of two API inputs: a full dispute or order id is matched exactly (`q`), other
 * text is a part of the store name (`search`, 2 to 80 characters). One character asks for nothing.
 */
export type DisputeSearch =
  | { readonly kind: 'none' }
  | { readonly kind: 'too-short' }
  | { readonly kind: 'id'; readonly value: string }
  | { readonly kind: 'store'; readonly value: string };

export function disputeSearchRoute(text: string): DisputeSearch {
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
  if (query.view !== 'all') params.set('view', query.view);
  const route = disputeSearchRoute(query.q);
  if (route.kind === 'id') params.set('q', route.value);
  if (route.kind === 'store') params.set('search', route.value);
  if (query.sellerId !== null) params.set('sellerId', query.sellerId);
  const { filters } = query;
  if (filters.status !== undefined) params.set('status', filters.status);
  if (filters.money !== undefined) params.set('money', filters.money);
  if (filters.evidenceDue !== undefined) {
    params.set('dueBefore', dueBeforeOf(filters.evidenceDue, context.now));
  }
  if (filters.opened !== undefined) {
    const range = presetRange(filters.opened, context.zone, context.now);
    if (range !== null) {
      params.set('from', range.from);
      params.set('to', range.to);
    }
  }
  return params;
}

export function queryString(query: Query, context: QueryContext): string {
  const params = selectorParams(query, context);
  if (context.paging === 'pages') {
    params.set('sort', query.sort);
    params.set('direction', query.direction);
    params.set('page', String(query.page));
    params.set('pageSize', String(query.pageSize));
  } else {
    params.set('limit', String(query.pageSize));
    const cursor = query.cursors[query.cursors.length - 1];
    if (cursor !== undefined) params.set('cursor', cursor);
  }
  return params.toString();
}
