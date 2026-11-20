// The query string of the Credit requests list: what the view, search, filters, sort and page ask
// GET wallet/admin/credit-requests for. Page numbers (List paging `pages`) send `page`,
// `pageSize`, `sort` and `direction`; Previous and next sends `limit` and `cursor` only, newest
// first (the API refuses a sort beside a cursor).

import type { ListPagingMode } from '../../sales/cursor-paging.ts';
import { presetRange } from '../../sales/date-presets.ts';
import { isUuid } from '../../sales/search-route.ts';
import { SEARCH_MAX, type Query } from './credit-requests-list-types.ts';

/**
 * The one search box takes an id only: a request id or a customer account id, matched exactly
 * (`q`). Any other text asks for nothing and the box says it is not an id.
 */
export type CreditSearch =
  | { readonly kind: 'none' }
  | { readonly kind: 'not-id' }
  | { readonly kind: 'id'; readonly value: string };

export function creditSearchRoute(text: string): CreditSearch {
  // A pasted tab or line break is a space: the API (and the BFF's value check) take printable text.
  // eslint-disable-next-line no-control-regex
  const value = Array.from(text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim())
    .slice(0, SEARCH_MAX)
    .join('');
  if (value === '') return { kind: 'none' };
  if (isUuid(value)) return { kind: 'id', value: value.toLowerCase() };
  return { kind: 'not-id' };
}

export interface QueryContext {
  readonly paging: ListPagingMode;
  /** The IANA zone of the table's times; the date presets are read on its clock (ADR-0005). */
  readonly zone: string;
  readonly now: Date;
}

/**
 * The keys that choose which rows the list holds (an export of "all matching" sends these). The
 * view is always sent: without it the API reads a `status` of granted as the view.
 */
export function selectorParams(query: Query, context: QueryContext): URLSearchParams {
  const params = new URLSearchParams();
  params.set('view', query.view);
  const route = creditSearchRoute(query.q);
  if (route.kind === 'id') params.set('q', route.value);
  const { filters } = query;
  if (filters.status !== undefined) params.set('status', filters.status);
  if (filters.reason !== undefined) params.set('reason', filters.reason);
  if (filters.approvalReason !== undefined) params.set('approvalReason', filters.approvalReason);
  if (filters.requestedBy !== undefined) params.set('requestedBy', filters.requestedBy);
  if (filters.requested !== undefined) {
    const range = presetRange(filters.requested, context.zone, context.now);
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
