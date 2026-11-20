// The seller page's Commission ledger as a compact super list (list 27): the answer of
// GET commission-payouts/admin/sellers/:id/ledger (apps/api commission-payouts.controller) and the
// list's own state. One seller's rows; no views and no saved filters.

import { isDatePreset, type DatePreset } from '../../sales/date-presets.ts';
import { LEDGER_KINDS, type Ledger, type LedgerKind } from '../types.ts';

export const PAGE_SIZES = [25, 50, 100] as const;
/** Rows that can be ticked one by one for an export (the API takes up to 200 ids). */
export const SELECTION_MAX = 200;
/** The API stops page numbers at this row; deeper rows need a filter. */
export const MAX_PAGED_ROWS = 10_000;

export const SORTS = ['recorded', 'occurred', 'amount'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';
/** Every sort starts with the newest or the largest. */
export const defaultDirection = (): Direction => 'desc';
/** Previous and next lists the newest record first only (the API refuses a sort beside a cursor). */
export const FIXED_SORT: Sort = 'recorded';

/** The row actions the API names, in the order of the menu; one it does not know is ignored. */
export const ROW_ACTIONS = ['open-order'] as const;
export type RowAction = (typeof ROW_ACTIONS)[number];

export const SIDES = ['credit', 'debit'] as const;
export type Side = (typeof SIDES)[number];

/** The amounts "at least" and "at most" offer, in whole units of the Market currency. */
export const AMOUNT_STEPS = ['10', '50', '100', '500', '1000'] as const;
export type AmountStep = (typeof AMOUNT_STEPS)[number];

/** A row of the list: the entry with everything the optional columns show. */
export type { LedgerEntry as LedgerListRow } from '../types.ts';
export type LedgerListPage = Ledger;

export const FILTER_FIELDS = ['kind', 'side', 'recorded', 'minAmount', 'maxAmount'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

/** The conditions of the filter panel; each is one value. */
export interface Filters {
  readonly kind?: LedgerKind;
  readonly side?: Side;
  readonly recorded?: DatePreset;
  readonly minAmount?: AmountStep;
  readonly maxAmount?: AmountStep;
}

export const filterCount = (filters: Filters): number => Object.keys(filters).length;

const pick = <T extends string>(list: readonly T[], value: string | undefined): T | undefined =>
  list.find((entry) => entry === value);

/** The filters a panel answer holds: only a known value of a known field. */
export function filtersOf(values: Readonly<Record<string, string | undefined>>): Filters {
  const kind = pick(LEDGER_KINDS, values['kind']);
  const side = pick(SIDES, values['side']);
  const minAmount = pick(AMOUNT_STEPS, values['minAmount']);
  const maxAmount = pick(AMOUNT_STEPS, values['maxAmount']);
  const recorded = values['recorded'];
  return {
    ...(kind === undefined ? {} : { kind }),
    ...(side === undefined ? {} : { side }),
    ...(isDatePreset(recorded) ? { recorded } : {}),
    ...(minAmount === undefined ? {} : { minAmount }),
    ...(maxAmount === undefined ? {} : { maxAmount }),
  };
}

export interface Query {
  /** The search box as typed: an order or seller order id (exact). */
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
  sort: 'recorded',
  direction: 'desc',
  page: 1,
  pageSize: PAGE_SIZES[0],
  cursors: [],
};
