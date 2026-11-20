// The Credit requests super list (list 24): the answer of GET wallet/admin/credit-requests (apps/api
// wallet admin-credit.dto.ts, `CreditListBody`) and the list's own state.

import { isDatePreset, type DatePreset } from '../../sales/date-presets.ts';
import { CREDIT_REASONS, type AdminCredit } from '../types.ts';

export const PAGE_SIZES = [25, 50, 100] as const;
/** Rows that can be ticked one by one for an export (the API takes up to 200 ids). */
export const SELECTION_MAX = 200;
/** The API stops page numbers at this row; deeper rows need a filter. */
export const MAX_PAGED_ROWS = 10_000;
/** A pasted id is 36 characters; the box takes a little more, for spaces around it. */
export const SEARCH_MAX = 80;

/** The views (tabs): the older queue's three, then every request. */
export const VIEWS = ['pending', 'decided', 'granted', 'all'] as const;
export type View = (typeof VIEWS)[number];
export const isView = (value: unknown): value is View => VIEWS.some((view) => view === value);

export const SORTS = ['requested', 'amount', 'expires', 'decided'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';
/** The expiry sort starts with the nearest expiry; the others newest (or largest) first. */
export const defaultDirection = (sort: Sort): Direction => (sort === 'expires' ? 'asc' : 'desc');

/** The row actions the API names, in the order of the menu; one it does not know is ignored. */
export const ROW_ACTIONS = ['open', 'approve', 'reject'] as const;
export type RowAction = (typeof ROW_ACTIONS)[number];

export interface CreditListRow extends AdminCredit {
  readonly actions: readonly string[];
}

export type ViewCounts = Readonly<Record<View, number>>;

export interface CreditListPage {
  readonly entries: readonly CreditListRow[];
  readonly counts: ViewCounts;
  /** Page numbers only; null with Previous and next. */
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number;
  /** Previous and next: the cursor of the next page, null on the last one. */
  readonly nextCursor: string | null;
}

export const FILTER_FIELDS = [
  'status',
  'reason',
  'approvalReason',
  'requestedBy',
  'requested',
] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

/** One status inside the view (the API's `status`). */
export const STATUSES = ['granted', 'pending', 'approved', 'rejected', 'expired'] as const;
export type StatusFilter = (typeof STATUSES)[number];

export const REASONS = CREDIT_REASONS;
export type ReasonFilter = (typeof REASONS)[number];

/** Why a request needed a second admin (the API's `approvalReason`). */
export const APPROVAL_REASONS = ['issue-cap', 'daily-cap'] as const;
export type ApprovalReasonFilter = (typeof APPROVAL_REASONS)[number];

/** The only "requested by" choice: the caller, sent as `requestedBy=me`. */
export const REQUESTED_BY = ['me'] as const;
export type RequestedByFilter = (typeof REQUESTED_BY)[number];

/** The conditions of the filter panel; each is one value. */
export interface Filters {
  readonly status?: StatusFilter;
  readonly reason?: ReasonFilter;
  readonly approvalReason?: ApprovalReasonFilter;
  readonly requestedBy?: RequestedByFilter;
  readonly requested?: DatePreset;
}

export const filterCount = (filters: Filters): number => Object.keys(filters).length;

const pick = <T extends string>(list: readonly T[], value: string | undefined): T | undefined =>
  list.find((entry) => entry === value);

/** The filters a panel answer holds: only a known value of a known field. */
export function filtersOf(values: Readonly<Record<string, string | undefined>>): Filters {
  const status = pick(STATUSES, values['status']);
  const reason = pick(REASONS, values['reason']);
  const approvalReason = pick(APPROVAL_REASONS, values['approvalReason']);
  const requestedBy = pick(REQUESTED_BY, values['requestedBy']);
  const requested = values['requested'];
  return {
    ...(status === undefined ? {} : { status }),
    ...(reason === undefined ? {} : { reason }),
    ...(approvalReason === undefined ? {} : { approvalReason }),
    ...(requestedBy === undefined ? {} : { requestedBy }),
    ...(isDatePreset(requested) ? { requested } : {}),
  };
}

export interface Query {
  readonly view: View;
  /** The search box as typed: a request id or a customer account id (exact). */
  readonly q: string;
  readonly filters: Filters;
  readonly sort: Sort;
  readonly direction: Direction;
  /** Page numbers: the page from 1. */
  readonly page: number;
  readonly pageSize: number;
  /** Previous and next: the cursors that opened each page after the first. */
  readonly cursors: readonly string[];
}

export const DEFAULT_QUERY: Query = {
  view: 'pending',
  q: '',
  filters: {},
  sort: 'requested',
  direction: 'desc',
  page: 1,
  pageSize: PAGE_SIZES[0],
  cursors: [],
};
