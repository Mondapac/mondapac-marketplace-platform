// The query string of the Blog posts list: what the view, search, filters, sort and page ask
// GET blog/admin/posts for. Page numbers (List paging `pages`) send `page`, `pageSize`, `sort` and
// `direction`; Previous and next sends `limit` and `cursor` only, newest created first (the API
// refuses a sort beside a cursor).

import type { ListPagingMode } from '../../sales/cursor-paging.ts';
import { presetRange } from '../../sales/date-presets.ts';
import { SEARCH_MAX, type Query } from './posts-list-types.ts';

/**
 * The search box text as the API takes it: any control or unassigned character is a space (a
 * pasted tab or line break), the ends are trimmed and the text is cut to the API's longest
 * search. Empty means no search. A ZWNJ (format character, common in Persian) is kept.
 */
export function searchText(text: string): string {
  return Array.from(text.replace(/[\p{Cc}\p{Co}\p{Cs}\p{Cn}]+/gu, ' ').trim())
    .slice(0, SEARCH_MAX)
    .join('')
    .trim();
}

export interface QueryContext {
  readonly paging: ListPagingMode;
  /** The IANA zone of the table's times; the date presets are read on its clock (ADR-0005). */
  readonly zone: string;
  readonly now: Date;
}

/**
 * The keys that choose which rows the list holds (an export of "all matching" sends these). The
 * view is always sent, so the API never reads a default for it.
 */
export function selectorParams(query: Query, context: QueryContext): URLSearchParams {
  const params = new URLSearchParams();
  params.set('view', query.view);
  const text = searchText(query.q);
  if (text !== '') params.set('q', text);
  const { filters } = query;
  if (filters.kind !== undefined) params.set('kind', filters.kind);
  if (filters.owner !== undefined) params.set('owner', filters.owner);
  if (filters.featured !== undefined) {
    params.set('featured', filters.featured === 'yes' ? 'true' : 'false');
  }
  if (filters.updated !== undefined) {
    const range = presetRange(filters.updated, context.zone, context.now);
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
