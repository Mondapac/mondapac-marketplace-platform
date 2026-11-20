// The Account deletion requests super list (list 25): the answer of GET
// customers/admin/deletion-requests (apps/api customers `admin-account-deletion-requests.controller`)
// and the list's own state.

import { isDatePreset, type DatePreset } from '../../sales/date-presets.ts';

export const PAGE_SIZES = [25, 50, 100] as const;
/** Rows that can be ticked one by one for an export (the API takes up to 200 ids). */
export const SELECTION_MAX = 200;
/** The API stops page numbers at this row; deeper rows need a filter. */
export const MAX_PAGED_ROWS = 10_000;
/** A pasted id is 36 characters; the box takes a little more, for spaces around it. */
export const SEARCH_MAX = 80;

/** The views (tabs): a request waits, is carried out, is cancelled or is done; then every one. */
export const VIEWS = ['pending', 'executing', 'cancelled', 'completed', 'all'] as const;
export type View = (typeof VIEWS)[number];
export const isView = (value: unknown): value is View => VIEWS.some((view) => view === value);

export const SORTS = ['scheduled', 'requested', 'cancelled', 'completed'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';
/** The deletion date starts with the earliest; the others with the most recent. */
export const defaultDirection = (sort: Sort): Direction => (sort === 'scheduled' ? 'asc' : 'desc');

/** The row actions the API names, in the order of the menu; one it does not know is ignored. */
export const ROW_ACTIONS = ['cancel'] as const;
export type RowAction = (typeof ROW_ACTIONS)[number];

export const STATUSES = ['pending', 'executing', 'cancelled', 'completed'] as const;
export const REQUESTERS = ['customer', 'admin'] as const;
export type Requester = (typeof REQUESTERS)[number];
/** Why a request was cancelled: the buyer, a sign-in during the wait, or an admin. */
export const CANCEL_REASONS = ['customer', 'sign-in', 'admin'] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export interface DeletionListRow {
  readonly requestId: string;
  readonly accountId: string;
  readonly requestedAt: string;
  readonly scheduledFor: string;
  /** One of {@link STATUSES}; a status this panel does not know shows as plain text. */
  readonly status: string;
  readonly requestedBy: Requester;
  readonly cancelledAt: string | null;
  readonly cancelReason: CancelReason | null;
  readonly completedAt: string | null;
  readonly actions: readonly string[];
}

export type ViewCounts = Readonly<Record<View, number>>;

export interface DeletionListPage {
  readonly entries: readonly DeletionListRow[];
  readonly counts: ViewCounts;
  /** Page numbers only; null with Previous and next. */
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number;
  /** Previous and next: the cursor of the next page, null on the last one. */
  readonly nextCursor: string | null;
}

export const FILTER_FIELDS = ['requestedBy', 'cancelReason', 'requested', 'deletes'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

/** "Deletes within": the next day, week or month from the moment the list was read. */
export const DELETES_WITHIN = ['24h', '7d', '30d'] as const;
export type DeletesWithin = (typeof DELETES_WITHIN)[number];

/** The conditions of the filter panel; each is one value. */
export interface Filters {
  readonly requestedBy?: Requester;
  readonly cancelReason?: CancelReason;
  readonly requested?: DatePreset;
  readonly deletes?: DeletesWithin;
}

export const filterCount = (filters: Filters): number => Object.keys(filters).length;

const pick = <T extends string>(list: readonly T[], value: string | undefined): T | undefined =>
  list.find((entry) => entry === value);

/** The filters a panel answer holds: only a known value of a known field. */
export function filtersOf(values: Readonly<Record<string, string | undefined>>): Filters {
  const requestedBy = pick(REQUESTERS, values['requestedBy']);
  const cancelReason = pick(CANCEL_REASONS, values['cancelReason']);
  const deletes = pick(DELETES_WITHIN, values['deletes']);
  const requested = values['requested'];
  return {
    ...(requestedBy === undefined ? {} : { requestedBy }),
    ...(cancelReason === undefined ? {} : { cancelReason }),
    ...(isDatePreset(requested) ? { requested } : {}),
    ...(deletes === undefined ? {} : { deletes }),
  };
}

export interface Query {
  readonly view: View;
  /** The search box as typed: a request id or a buyer account id (exact). */
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
  sort: 'scheduled',
  direction: 'asc',
  page: 1,
  pageSize: PAGE_SIZES[0],
  cursors: [],
};
