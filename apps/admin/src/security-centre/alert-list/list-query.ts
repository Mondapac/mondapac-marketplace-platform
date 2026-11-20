// The query string of the alert list: what the view, search, filters, sort and page ask
// GET security/admin/alerts/list for. `paging` names the Market's List paging setting; both modes
// send the page and the sort (Previous and next only gets no total back).

import type { ListPagingMode } from '../../sales/cursor-paging.ts';
import { presetRange } from '../../sales/date-presets.ts';
import { PAGE_SIZE, SEARCH_MAX, type Query } from './list-types.ts';

export interface QueryContext {
  readonly paging: ListPagingMode;
  /** The IANA zone of the table's times; the date presets are read on its clock (ADR-0005). */
  readonly zone: string;
  readonly now: Date;
}

// Control characters and the bidirectional marks: the API refuses them in a key, and a pasted id
// or address never needs them.
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** The key the search box asks for: no control marks, trimmed, at most the API's 64 characters. */
export function searchText(text: string): string {
  return Array.from(text.replace(CONTROLS, ' ').trim()).slice(0, SEARCH_MAX).join('').trim();
}

/** The keys that choose which rows the list holds (an export of "all matching" sends these). */
export function selectorParams(query: Query, context: QueryContext): URLSearchParams {
  const params = new URLSearchParams();
  const { filters } = query;
  params.set('view', query.view);
  const q = searchText(query.q);
  if (q !== '') params.set('keyValue', q);
  if (filters.severity !== undefined) params.set('severity', filters.severity);
  if (filters.rule !== undefined) params.set('rule', filters.rule);
  if (filters.keyType !== undefined) params.set('keyType', filters.keyType);
  if (filters.minEvents !== undefined) params.set('minEvents', filters.minEvents);
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
  params.set('paging', context.paging);
  params.set('page', String(query.page));
  params.set('pageSize', String(PAGE_SIZE));
  params.set('sort', query.sort);
  params.set('direction', query.direction);
  return params.toString();
}
