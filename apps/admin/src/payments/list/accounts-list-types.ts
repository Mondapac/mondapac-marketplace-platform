// The Seller accounts super list (list 22): the answer of GET payments/admin/connected-accounts
// (apps/api payments payout-account.dto.ts, `ConnectedAccountPageBody`) and the list's own state.
// Read-only: no action on this list moves money or changes an account.

import type { ListPagingMode } from '../../sales/cursor-paging.ts';
import { isDatePreset, type DatePreset } from '../../sales/date-presets.ts';
import { STATUSES, type ConnectedAccountRow } from '../types.ts';

export const PAGE_SIZES = [25, 50, 100] as const;
/** Rows that can be ticked one by one for an export (the API takes up to 200 ids). */
export const SELECTION_MAX = 200;
/** The API stops page numbers at this row; deeper rows need a filter. */
export const MAX_PAGED_ROWS = 10_000;
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 80;

/** The views (tabs): every account, then one per status. */
export const VIEWS = ['all', ...STATUSES] as const;
export type View = (typeof VIEWS)[number];

export const SORTS = ['created', 'last-read', 'requirements'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';
/** Every sort starts newest (or most details due) first. */
export const defaultDirection = (): Direction => 'desc';

export const ROW_ACTIONS = ['open'] as const;

export interface AccountListRow extends ConnectedAccountRow {
  readonly actions: readonly string[];
}

export type ViewCounts = Readonly<Record<View, number>>;

export interface AccountListPage {
  readonly items: readonly AccountListRow[];
  /** Per view for the same search and filters; null with Previous and next. */
  readonly counts: ViewCounts | null;
  /** Null with Previous and next. */
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  readonly hasNext: boolean;
  /** The store search matched more stores than it can carry: the admin should narrow it. */
  readonly searchCapped: boolean;
}

export const FILTER_FIELDS = ['ready', 'requirements', 'waiting', 'created'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

export const READY_VALUES = ['yes', 'no'] as const;
export const REQUIREMENT_VALUES = ['past-due', 'due', 'none'] as const;
export const WAITING_VALUES = ['cooling-off', 'paused'] as const;

export interface Filters {
  readonly ready?: (typeof READY_VALUES)[number];
  readonly requirements?: (typeof REQUIREMENT_VALUES)[number];
  readonly waiting?: (typeof WAITING_VALUES)[number];
  readonly created?: DatePreset;
}

export const filterCount = (filters: Filters): number => Object.keys(filters).length;

const pick = <T extends string>(list: readonly T[], value: string | undefined): T | undefined =>
  list.find((entry) => entry === value);

/** The filters a panel answer holds: only a known value of a known field. */
export function filtersOf(values: Readonly<Record<string, string | undefined>>): Filters {
  const ready = pick(READY_VALUES, values['ready']);
  const requirements = pick(REQUIREMENT_VALUES, values['requirements']);
  const waiting = pick(WAITING_VALUES, values['waiting']);
  const created = values['created'];
  return {
    ...(ready === undefined ? {} : { ready }),
    ...(requirements === undefined ? {} : { requirements }),
    ...(waiting === undefined ? {} : { waiting }),
    ...(isDatePreset(created) ? { created } : {}),
  };
}

export interface Query {
  readonly view: View;
  /** The search box as typed: a seller id (exact) or a part of the store name. */
  readonly q: string;
  readonly filters: Filters;
  readonly sort: Sort;
  readonly direction: Direction;
  readonly page: number;
  readonly pageSize: number;
}

export const DEFAULT_QUERY: Query = {
  view: 'all',
  q: '',
  filters: {},
  sort: 'created',
  direction: 'desc',
  page: 1,
  pageSize: PAGE_SIZES[0],
};

export const isView = (value: unknown): value is View => VIEWS.some((view) => view === value);
