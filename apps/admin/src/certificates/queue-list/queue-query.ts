// The query string of the queue list: what the view, search, filters, sort and page ask
// GET certification/admin/seller-certificates/list for. `paging` names the Market's List paging
// setting; both modes send the page and the sort (Previous and next only gets no total back).

import type { ListPagingMode } from '../../sales/cursor-paging.ts';
import { presetRange } from '../../sales/date-presets.ts';
import { queueSearchRoute } from './queue-search.ts';
import { PAGE_SIZE, type Query } from './queue-types.ts';

export interface QueryContext {
  readonly paging: ListPagingMode;
  /** The IANA zone of the table's times; the date presets are read on its clock (ADR-0005). */
  readonly zone: string;
  readonly now: Date;
}

/** The keys that choose which rows the list holds (an export of "all matching" sends these). */
export function selectorParams(query: Query, context: QueryContext): URLSearchParams {
  const params = new URLSearchParams();
  const { filters } = query;
  if (query.view !== 'all') params.set('view', query.view);
  if (filters.type !== undefined) params.set('type', filters.type);
  const route = queueSearchRoute(query.q);
  if (route.kind === 'id') params.set('q', route.value);
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
  params.set('paging', context.paging);
  params.set('page', String(query.page));
  params.set('pageSize', String(PAGE_SIZE));
  params.set('sort', query.sort);
  params.set('direction', query.direction);
  return params.toString();
}
