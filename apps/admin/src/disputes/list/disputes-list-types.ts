// The Disputes super list (list 23): the answer of GET commission-payouts/admin/disputes (apps/api
// commission-payouts dispute.dto.ts, `DisputeListBody`) and the list's own state.

import { isDatePreset, type DatePreset } from '../../sales/date-presets.ts';
import { BUCKETS, type DisputeRow } from '../types.ts';

export const PAGE_SIZES = [25, 50, 100] as const;
/** Rows that can be ticked one by one for an export (the API takes up to 200 ids). */
export const SELECTION_MAX = 200;
/** The API stops page numbers at this row; deeper rows need a filter. */
export const MAX_PAGED_ROWS = 10_000;
/** The store search: 2 to 80 characters (a dispute or order id is matched exactly instead). */
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 80;

/** The views (tabs): every case, then one per bucket. */
export const VIEWS = ['all', ...BUCKETS] as const;
export type View = (typeof VIEWS)[number];

export const SORTS = ['opened', 'amount', 'evidence-due', 'updated'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';
/** The deadline sort starts with the nearest deadline; the others newest (or largest) first. */
export const defaultDirection = (sort: Sort): Direction =>
  sort === 'evidence-due' ? 'asc' : 'desc';

/** The row actions the API names, in the order of the menu; one it does not know is ignored. */
export const ROW_ACTIONS = ['open', 'decide'] as const;
export type RowAction = (typeof ROW_ACTIONS)[number];

export interface DisputeListRow extends DisputeRow {
  readonly updatedAt: string;
  readonly actions: readonly string[];
}

export type ViewCounts = Readonly<Record<View, number>>;

export interface DisputeListPage {
  readonly disputes: readonly DisputeListRow[];
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

export const FILTER_FIELDS = ['status', 'money', 'evidenceDue', 'opened'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

/** Stripe's status of a case (the API's `status`). */
export const STATUSES = [
  'warning_needs_response',
  'warning_under_review',
  'warning_closed',
  'needs_response',
  'under_review',
  'won',
  'lost',
  'prevented',
] as const;
export type StatusFilter = (typeof STATUSES)[number];

/** What the bank did with the money (the API's `money`). */
export const MONEY_STATES = ['withdrawn', 'inquiry', 'reinstated', 'none'] as const;
export type MoneyFilter = (typeof MONEY_STATES)[number];

/** The evidence deadline, as `dueBefore`: already past, or within the next day, 3 or 7 days. */
export const DUE_PRESETS = ['overdue', 'next-24-hours', 'next-3-days', 'next-7-days'] as const;
export type DuePreset = (typeof DUE_PRESETS)[number];
const DUE_HOURS: Readonly<Record<DuePreset, number>> = {
  overdue: 0,
  'next-24-hours': 24,
  'next-3-days': 72,
  'next-7-days': 168,
};
/** The instant `dueBefore` asks for, from the time the list is read. */
export const dueBeforeOf = (preset: DuePreset, now: Date): string =>
  new Date(now.getTime() + DUE_HOURS[preset] * 3_600_000).toISOString();

/** The conditions of the filter panel; each is one value. */
export interface Filters {
  readonly status?: StatusFilter;
  readonly money?: MoneyFilter;
  readonly evidenceDue?: DuePreset;
  readonly opened?: DatePreset;
}

export const filterCount = (filters: Filters): number => Object.keys(filters).length;

const pick = <T extends string>(list: readonly T[], value: string | undefined): T | undefined =>
  list.find((entry) => entry === value);

/** The filters a panel answer holds: only a known value of a known field. */
export function filtersOf(values: Readonly<Record<string, string | undefined>>): Filters {
  const status = pick(STATUSES, values['status']);
  const money = pick(MONEY_STATES, values['money']);
  const evidenceDue = pick(DUE_PRESETS, values['evidenceDue']);
  const opened = values['opened'];
  return {
    ...(status === undefined ? {} : { status }),
    ...(money === undefined ? {} : { money }),
    ...(evidenceDue === undefined ? {} : { evidenceDue }),
    ...(isDatePreset(opened) ? { opened } : {}),
  };
}

export interface Query {
  readonly view: View;
  /** The search box as typed: a dispute or order id (exact) or a part of a store name. */
  readonly q: string;
  readonly filters: Filters;
  /** One seller's cases, from a link (`?sellerId=`); the panel has no picker for it. */
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
  sort: 'opened',
  direction: 'desc',
  page: 1,
  pageSize: PAGE_SIZES[0],
  cursors: [],
};

export const isView = (value: unknown): value is View => VIEWS.some((view) => view === value);
