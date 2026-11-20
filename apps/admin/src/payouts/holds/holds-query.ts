// The query string of the seller payout holds list: what the search, filters, sort and page ask
// GET commission-payouts/admin/sellers/:id/payout-holds for. Page numbers (List paging `pages`)
// send `page`, `pageSize`, `sort` and `direction`; Previous and next sends `limit` and `cursor`
// only, newest placement first (the API refuses a sort beside a cursor). The seller is in the
// path, never in the query.

import type { ListPagingMode } from '../../sales/cursor-paging.ts';
import { presetRange } from '../../sales/date-presets.ts';
import type { Query } from './holds-list-types.ts';

export interface QueryContext {
  readonly paging: ListPagingMode;
  /** The IANA zone of the table's times; the date presets are read on its clock (ADR-0005). */
  readonly zone: string;
  readonly now: Date;
}

/**
 * The keys that choose which holds the list shows (an export of "all matching" sends these).
 * `sellerOrderId` is the seller order id of the search (already lower case).
 */
export function selectorParams(
  query: Query,
  context: QueryContext,
  search: string,
): URLSearchParams {
  const params = new URLSearchParams();
  if (search !== '') params.set('sellerOrderId', search);
  const { filters } = query;
  if (filters.status !== undefined) params.set('status', filters.status);
  if (filters.reason !== undefined) params.set('reason', filters.reason);
  if (filters.origin !== undefined) params.set('origin', filters.origin);
  if (filters.scope !== undefined) params.set('scope', filters.scope);
  if (filters.placed !== undefined) {
    const range = presetRange(filters.placed, context.zone, context.now);
    if (range !== null) {
      params.set('from', range.from);
      params.set('to', range.to);
    }
  }
  return params;
}

export function queryString(query: Query, context: QueryContext, search: string): string {
  const params = selectorParams(query, context, search);
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
