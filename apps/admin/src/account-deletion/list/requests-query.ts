// The query string of the Account deletion requests list: what the view, search, filters, sort and
// page ask GET customers/admin/deletion-requests for. Page numbers (List paging `pages`) send
// `page`, `pageSize`, `sort` and `direction`; Previous and next sends `limit` and `cursor` only,
// earliest deletion date first (the API refuses a sort beside a cursor).

import type { ListPagingMode } from '../../sales/cursor-paging.ts';
import { presetRange } from '../../sales/date-presets.ts';
import { isUuid } from '../../sales/search-route.ts';
import {
  DELETES_WITHIN,
  SEARCH_MAX,
  type DeletesWithin,
  type Query,
} from './requests-list-types.ts';

/**
 * The one search box takes an id only: a request id or a buyer account id, matched exactly (`q`).
 * Any other text asks for nothing and the box says it is not an id.
 */
export type DeletionSearch =
  | { readonly kind: 'none' }
  | { readonly kind: 'not-id' }
  | { readonly kind: 'id'; readonly value: string };

export function deletionSearchRoute(text: string): DeletionSearch {
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

const DAY_MS = 24 * 60 * 60 * 1000;
const WITHIN_DAYS: Readonly<Record<DeletesWithin, number>> = { '24h': 1, '7d': 7, '30d': 30 };

/** The instant "within 7 days" means: that many whole days after `now` (an instant, not a day). */
export const deletesBefore = (within: DeletesWithin, now: Date): string =>
  new Date(now.getTime() + WITHIN_DAYS[within] * DAY_MS).toISOString();

export const isDeletesWithin = (value: unknown): value is DeletesWithin =>
  DELETES_WITHIN.some((entry) => entry === value);

/**
 * The keys that choose which rows the list holds (an export of "all matching" sends these). The
 * view is always sent, so the API never reads a default for it.
 */
export function selectorParams(query: Query, context: QueryContext): URLSearchParams {
  const params = new URLSearchParams();
  params.set('view', query.view);
  const route = deletionSearchRoute(query.q);
  if (route.kind === 'id') params.set('q', route.value);
  const { filters } = query;
  if (filters.requestedBy !== undefined) params.set('requestedBy', filters.requestedBy);
  if (filters.cancelReason !== undefined) params.set('cancelReason', filters.cancelReason);
  if (filters.requested !== undefined) {
    const range = presetRange(filters.requested, context.zone, context.now);
    if (range !== null) {
      params.set('from', range.from);
      params.set('to', range.to);
    }
  }
  if (filters.deletes !== undefined) {
    params.set('scheduledBefore', deletesBefore(filters.deletes, context.now));
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
