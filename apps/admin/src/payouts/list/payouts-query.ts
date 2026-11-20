// The query string of the Payouts list: what the view, search, filters, sort and page ask
// GET commission-payouts/admin/payouts for. Page numbers (List paging `pages`) send `page`,
// `pageSize`, `sort` and `direction`; Previous and next sends `limit` and `cursor` only, newest
// first (the API refuses a sort beside a cursor).

import type { ListPagingMode } from '../../sales/cursor-paging.ts';
import { presetRange } from '../../sales/date-presets.ts';
import { isUuid } from '../../sales/search-route.ts';
import { SEARCH_MAX, SEARCH_MIN, type Query } from './payouts-list-types.ts';

/**
 * The one search box fills one of two API inputs: a full payout id is matched exactly (`q`), other
 * text is a part of the store name (`search`, 2 to 80 characters). One character asks for nothing.
 */
export type PayoutSearch =
  | { readonly kind: 'none' }
  | { readonly kind: 'too-short' }
  | { readonly kind: 'id'; readonly value: string }
  | { readonly kind: 'store'; readonly value: string };

export function payoutSearchRoute(text: string): PayoutSearch {
  const value = Array.from(text.trim()).slice(0, SEARCH_MAX).join('');
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
  const route = payoutSearchRoute(query.q);
  if (route.kind === 'id') params.set('q', route.value);
  if (route.kind === 'store') params.set('search', route.value);
  if (query.sellerId !== null) params.set('sellerId', query.sellerId);
  const { filters } = query;
  if (filters.approvalMode !== undefined) params.set('approvalMode', filters.approvalMode);
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
