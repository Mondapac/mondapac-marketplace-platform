// The Invoices query string: what the tab, search, filter, sort and page ask
// GET ordering/admin/documents for. Page numbers send `page`, `pageSize`, `sort` and `direction`;
// Previous and next sends `limit` and `cursor` only (the API refuses the mix: `with-cursor`).

import { PAGE_SIZE, cursorOf, type ListPagingMode } from '../cursor-paging.ts';
import { presetRange } from '../date-presets.ts';
import { routeSearch } from '../search-route.ts';
import type { Query } from './invoices-types.ts';

export interface QueryContext {
  readonly paging: ListPagingMode;
  /** The IANA zone of the table's times; the date presets are read on its clock (ADR-0005). */
  readonly zone: string;
  readonly now: Date;
}

export const invoiceSearchRoute = (text: string) => routeSearch(text);

export function queryString(query: Query, context: QueryContext): string {
  const params = new URLSearchParams();
  params.set('kind', query.tab);
  const route = invoiceSearchRoute(query.q);
  if (route.kind === 'q') params.set('q', route.value);
  else if (route.kind === 'search') params.set('search', route.value);
  if (query.sellerId !== null) params.set('sellerId', query.sellerId);
  if (query.filters.issued !== undefined) {
    const range = presetRange(query.filters.issued, context.zone, context.now);
    if (range !== null) {
      params.set('from', range.from);
      params.set('to', range.to);
    }
  }
  if (context.paging === 'pages') {
    params.set('page', String(query.page));
    params.set('pageSize', String(PAGE_SIZE));
    params.set('sort', query.sort);
    params.set('direction', query.direction);
  } else {
    params.set('limit', String(PAGE_SIZE));
    const cursor = cursorOf(query.cursors);
    if (cursor !== null) params.set('cursor', cursor);
  }
  return params.toString();
}
