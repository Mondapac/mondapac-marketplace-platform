// The Payouts super list (list 21): the answer of GET commission-payouts/admin/payouts (apps/api
// commission-payouts payout.dto.ts, `PayoutListBody`) and the list's own state.

import { isDatePreset, type DatePreset } from '../../sales/date-presets.ts';
import type { PayoutRow } from '../types.ts';

export const PAGE_SIZES = [25, 50, 100] as const;
/** Rows that can be ticked one by one for an export (the API takes up to 200 ids). */
export const SELECTION_MAX = 200;
/** The API stops page numbers at this row; deeper rows need a filter. */
export const MAX_PAGED_ROWS = 10_000;
/** The store search: 2 to 80 characters (a payout id is matched exactly instead). */
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 80;

/** The views (tabs) and their order. Cancelled and settled-against-debt payouts show under All. */
export const VIEWS = ['all', 'awaiting-approval', 'sending', 'paid', 'failed', 'not-sent'] as const;
export type View = (typeof VIEWS)[number];

export const SORTS = ['created', 'amount', 'state-changed', 'slot'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';
/** Every sort starts newest (or largest) first, as the API does. */
export const defaultDirection = (): Direction => 'desc';

/** The row actions the API names, in the order of the menu; one it does not know is ignored. */
export const ROW_ACTIONS = ['open', 'approve', 'place-hold', 'release-hold'] as const;
export type RowAction = (typeof ROW_ACTIONS)[number];

export interface PayoutListRow extends PayoutRow {
  /** The seller's active admin hold over the whole seller (Release), or null. */
  readonly activeHoldId: string | null;
  readonly actions: readonly string[];
}

export type ViewCounts = Readonly<Record<View, number>>;

export interface PayoutListPage {
  readonly payouts: readonly PayoutListRow[];
  readonly counts: ViewCounts;
  /** Page numbers only; null with Previous and next. */
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number;
  /** Previous and next: the cursor of the next page, null on the last one. */
  readonly nextCursor: string | null;
  /** The store search matched more stores than can be listed: the admin should narrow it. */
  readonly searchCapped: boolean;
}

export const FILTER_FIELDS = ['approvalMode', 'created'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

export const APPROVAL_MODES = ['AUTO', 'MANUAL'] as const;
export type ApprovalModeFilter = (typeof APPROVAL_MODES)[number];

/** The conditions of the filter panel; each is one value. */
export interface Filters {
  readonly approvalMode?: ApprovalModeFilter;
  readonly created?: DatePreset;
}

export const filterCount = (filters: Filters): number => Object.keys(filters).length;

/** The filters a panel answer holds: only a known value of a known field. */
export function filtersOf(values: Readonly<Record<string, string | undefined>>): Filters {
  const next: { approvalMode?: ApprovalModeFilter; created?: DatePreset } = {};
  const mode = APPROVAL_MODES.find((value) => value === values['approvalMode']);
  if (mode !== undefined) next.approvalMode = mode;
  const created = values['created'];
  if (isDatePreset(created)) next.created = created;
  return next;
}

export interface Query {
  readonly view: View;
  /** The search box as typed: a payout id (exact) or a part of the store name. */
  readonly q: string;
  readonly filters: Filters;
  /** One seller's payouts, from a link (`?sellerId=`); the panel has no picker for it. */
  readonly sellerId: string | null;
  readonly sort: Sort;
  readonly direction: Direction;
  /** Page numbers: the page from 1. */
  readonly page: number;
  readonly pageSize: number;
  /** Previous and next: the cursors that opened each page after the first. */
  readonly cursors: readonly string[];
}

export const DEFAULT_QUERY: Query = {
  view: 'all',
  q: '',
  filters: {},
  sellerId: null,
  sort: 'created',
  direction: 'desc',
  page: 1,
  pageSize: PAGE_SIZES[0],
  cursors: [],
};

export const isView = (value: unknown): value is View => VIEWS.some((view) => view === value);
