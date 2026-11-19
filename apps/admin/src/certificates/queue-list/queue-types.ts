// The certificate review queue as a super list: the answer of GET
// certification/admin/seller-certificates/list (apps/api certification own-certificate.dto.ts,
// `ReviewQueueListView`) and the list's own state. One row per waiting submission.

import type { ListPagingMode } from '../../sales/cursor-paging.ts';
import { isDatePreset, type DatePreset } from '../../sales/date-presets.ts';
import type { QueueRow } from '../types.ts';

export const PAGE_SIZE = 25;
/** Rows that can be ticked one by one for an export (the API takes up to 200 ids). */
export const SELECTION_MAX = 200;

/** The views: every waiting submission, then one per kind. */
export const VIEWS = ['all', 'initial', 'resubmission', 'renewal'] as const;
export type View = (typeof VIEWS)[number];

export const SORTS = ['queue', 'submitted', 'type'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';
/** Every sort starts in its natural order: review order, longest waiting, A to Z. */
export const defaultDirection = (): Direction => 'asc';

/** The row actions the API names; one it does not know is ignored. */
export const ROW_ACTIONS = ['open', 'decide'] as const;
export type RowAction = (typeof ROW_ACTIONS)[number];

export interface QueueListRow extends QueueRow {
  readonly actions: readonly string[];
}

export interface QueueCounts {
  readonly all: number;
  readonly initial: number;
  readonly resubmission: number;
  readonly renewal: number;
}

export interface QueueListPage {
  readonly items: readonly QueueListRow[];
  /** Null with Previous and next. */
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  readonly hasNext: boolean;
  readonly counts: QueueCounts;
  /** More are waiting than the 500 the list reads: the newest are not listed. */
  readonly truncated: boolean;
}

export const FILTER_FIELDS = ['type', 'submitted'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

/** The conditions of the filter panel; each is one value. `type` is a certification type code. */
export interface Filters {
  readonly type?: string;
  readonly submitted?: DatePreset;
}

export const filterCount = (filters: Filters): number => Object.keys(filters).length;

const TYPE_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The filters a panel answer holds: only a known value of a known field. */
export function filtersOf(values: Readonly<Record<string, string>>): Filters {
  const next: { type?: string; submitted?: DatePreset } = {};
  const type = values['type'];
  if (type !== undefined && TYPE_CODE.test(type)) next.type = type;
  const submitted = values['submitted'];
  if (isDatePreset(submitted)) next.submitted = submitted;
  return next;
}

export interface Query {
  readonly view: View;
  /** A certificate or submission id, as typed and trimmed. */
  readonly q: string;
  readonly filters: Filters;
  /** One seller's submissions, from a link (`?sellerId=`); the panel has no picker for it. */
  readonly sellerId: string | null;
  readonly sort: Sort;
  readonly direction: Direction;
  readonly page: number;
}

export const DEFAULT_QUERY: Query = {
  view: 'all',
  q: '',
  filters: {},
  sellerId: null,
  sort: 'queue',
  direction: 'asc',
  page: 1,
};
