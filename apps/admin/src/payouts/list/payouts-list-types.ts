// The Payouts super list (list 21): the answer of GET commission-payouts/admin/payouts (apps/api
// commission-payouts payout.dto.ts, `PayoutListBody`) and the list's own state.

import { isDatePreset, type DatePreset } from '../../sales/date-presets.ts';
import { PAYOUT_STATES, type PayoutRow, type PayoutState } from '../types.ts';

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

export const FILTER_FIELDS = [
  'status',
  'approvalMode',
  'created',
  'minAmount',
  'maxAmount',
] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

export const APPROVAL_MODES = ['AUTO', 'MANUAL'] as const;
export type ApprovalModeFilter = (typeof APPROVAL_MODES)[number];

/**
 * The states each view holds, as the API's own table does (a voided payout and one settled by
 * netting show under All only). The Status filter works inside the view, so it offers these.
 */
export const VIEW_STATES: Readonly<Record<Exclude<View, 'all'>, readonly PayoutState[]>> = {
  'awaiting-approval': ['awaiting-approval'],
  sending: ['approved', 'instructing', 'instructed'],
  paid: ['paid'],
  failed: ['failed'],
  'not-sent': ['not-sent'],
};

/** The statuses the filter offers in a view: every state under All, the view's own otherwise. */
export const statusesOf = (view: View): readonly PayoutState[] =>
  view === 'all' ? PAYOUT_STATES : VIEW_STATES[view];

/** The fixed amount steps of the filter, in whole units of the Market currency. */
export const AMOUNT_STEPS = ['10', '50', '100', '500', '1000', '5000'] as const;
export type AmountStep = (typeof AMOUNT_STEPS)[number];
export const isAmountStep = (value: unknown): value is AmountStep =>
  AMOUNT_STEPS.some((step) => step === value);

/** The conditions of the filter panel; each is one value. Amounts are whole units, not minor. */
export interface Filters {
  readonly status?: PayoutState;
  readonly approvalMode?: ApprovalModeFilter;
  readonly created?: DatePreset;
  readonly minAmount?: AmountStep;
  readonly maxAmount?: AmountStep;
}

export const filterCount = (filters: Filters): number => Object.keys(filters).length;

/** The filters a panel answer holds: only a known value of a known field. */
export function filtersOf(values: Readonly<Record<string, string | undefined>>): Filters {
  const next: {
    -readonly [K in keyof Filters]: Filters[K];
  } = {};
  const status = PAYOUT_STATES.find((value) => value === values['status']);
  if (status !== undefined) next.status = status;
  const mode = APPROVAL_MODES.find((value) => value === values['approvalMode']);
  if (mode !== undefined) next.approvalMode = mode;
  const created = values['created'];
  if (isDatePreset(created)) next.created = created;
  const min = values['minAmount'];
  if (isAmountStep(min)) next.minAmount = min;
  const max = values['maxAmount'];
  if (isAmountStep(max)) next.maxAmount = max;
  return next;
}

/** The filters that still fit a view: a status outside it is dropped. */
export function filtersForView(filters: Filters, view: View): Filters {
  if (filters.status === undefined || statusesOf(view).includes(filters.status)) return filters;
  return Object.fromEntries(Object.entries(filters).filter(([name]) => name !== 'status'));
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
