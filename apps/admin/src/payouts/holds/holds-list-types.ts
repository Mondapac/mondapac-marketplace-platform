// The seller page's Payout holds as a compact super list (list 28): the answer of
// GET commission-payouts/admin/sellers/:id/payout-holds (apps/api commission-payouts.controller)
// and the list's own state. One seller's holds; no views and no saved filters.

import { isDatePreset, type DatePreset } from '../../sales/date-presets.ts';
import { HOLD_REASONS, type PayoutHold } from '../seller-types.ts';

export const PAGE_SIZES = [25, 50, 100] as const;
/** Rows that can be ticked one by one for an export (the API takes up to 200 ids). */
export const SELECTION_MAX = 200;
/** The API stops page numbers at this row; deeper rows need a filter. */
export const MAX_PAGED_ROWS = 10_000;

/** Active holds first (the default), then by placement, then by release. */
export const SORTS = ['active-first', 'placed', 'released'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';
/** Every sort starts with the newest (the newest hold, the latest release). */
export const defaultDirection = (): Direction => 'desc';
/** Previous and next lists the newest placement first only (no sort beside a cursor). */
export const FIXED_SORT: Sort = 'placed';

/**
 * The row actions this panel acts on, in the order of the menu. The API also names `open-order`
 * for a hold on one seller order; the panel has no page for a seller order (an order page is
 * keyed by the order, which a hold does not carry), so that one is ignored.
 */
export const ROW_ACTIONS = ['release'] as const;
export type RowAction = (typeof ROW_ACTIONS)[number];

export const STATUSES = ['active', 'released'] as const;
export const ORIGINS = ['admin', 'system'] as const;
export const SCOPES = ['seller', 'order'] as const;

export interface HoldListRow extends PayoutHold {
  readonly actions: readonly string[];
}

export interface HoldCounts {
  readonly active: number;
  readonly released: number;
}

export interface HoldListPage {
  readonly holds: readonly HoldListRow[];
  /** The seller's holds per status, whatever the filter. */
  readonly counts: HoldCounts;
  /** Page numbers only; null with Previous and next. */
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number;
  /** Previous and next: the cursor of the next page, null on the last one. */
  readonly nextCursor: string | null;
}

export const FILTER_FIELDS = ['status', 'reason', 'origin', 'scope', 'placed'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

/** The conditions of the filter panel; each is one value. */
export interface Filters {
  readonly status?: (typeof STATUSES)[number];
  readonly reason?: (typeof HOLD_REASONS)[number];
  readonly origin?: (typeof ORIGINS)[number];
  readonly scope?: (typeof SCOPES)[number];
  readonly placed?: DatePreset;
}

export const filterCount = (filters: Filters): number => Object.keys(filters).length;

const pick = <T extends string>(list: readonly T[], value: string | undefined): T | undefined =>
  list.find((entry) => entry === value);

/** The filters a panel answer holds: only a known value of a known field. */
export function filtersOf(values: Readonly<Record<string, string | undefined>>): Filters {
  const status = pick(STATUSES, values['status']);
  const reason = pick(HOLD_REASONS, values['reason']);
  const origin = pick(ORIGINS, values['origin']);
  const scope = pick(SCOPES, values['scope']);
  const placed = values['placed'];
  return {
    ...(status === undefined ? {} : { status }),
    ...(reason === undefined ? {} : { reason }),
    ...(origin === undefined ? {} : { origin }),
    ...(scope === undefined ? {} : { scope }),
    ...(isDatePreset(placed) ? { placed } : {}),
  };
}

export interface Query {
  /** The search box as typed: a seller order id (exact). */
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
  q: '',
  filters: {},
  sort: 'active-first',
  direction: 'desc',
  page: 1,
  pageSize: PAGE_SIZES[0],
  cursors: [],
};
