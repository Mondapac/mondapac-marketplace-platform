// The Shipments query string: what the tab, search, filters, sort and page ask
// GET ordering/admin/shipments for. Page numbers send `page`, `pageSize`, `sort` and `direction`;
// Previous and next sends `limit` and `cursor` only (the API refuses the mix: `with-cursor`).

import { PAGE_SIZE, cursorOf, type ListPagingMode } from '../cursor-paging.ts';
import { presetRange, type DatePreset } from '../date-presets.ts';
import { shipmentSearchRoute } from './shipments-search.ts';
import type { Query } from './shipments-types.ts';

export interface QueryContext {
  readonly paging: ListPagingMode;
  /** The IANA zone of the table's times; the date presets are read on its clock (ADR-0005). */
  readonly zone: string;
  readonly now: Date;
}

function setRange(
  params: URLSearchParams,
  preset: DatePreset | undefined,
  names: readonly [string, string],
  context: QueryContext,
) {
  if (preset === undefined) return;
  const range = presetRange(preset, context.zone, context.now);
  if (range === null) return;
  params.set(names[0], range.from);
  params.set(names[1], range.to);
}

export function queryString(query: Query, context: QueryContext): string {
  const params = new URLSearchParams();
  const { filters } = query;
  if (query.tab !== 'all' && query.tab !== 'attention') params.set('stage', query.tab);
  // The Needs attention tab is `attention=any`; the problem filter can narrow it to one code.
  const attention = filters.attention ?? (query.tab === 'attention' ? 'any' : undefined);
  if (attention !== undefined) params.set('attention', attention);
  if (filters.deliveryMethod !== undefined) params.set('deliveryMethod', filters.deliveryMethod);
  const route = shipmentSearchRoute(query.q, query.scope);
  if (route.kind === 'q') params.set('q', route.value);
  else if (route.kind === 'search') params.set('search', route.value);
  if (query.sellerId !== null) params.set('sellerId', query.sellerId);
  setRange(params, filters.paid, ['paidFrom', 'paidTo'], context);
  setRange(params, filters.shipped, ['shippedFrom', 'shippedTo'], context);
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
