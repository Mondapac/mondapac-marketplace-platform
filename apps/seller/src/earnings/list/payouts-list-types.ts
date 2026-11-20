// The Earnings payout list (super list 33): the list's own state. The answer of
// GET commission-payouts/seller/payouts is `OwnPayouts` in ../payout-types.ts.

import { DATE_PRESETS } from '../../orders/date-presets.ts';
import { PAYOUT_STATUSES, type PayoutStatus } from '../payout-types.ts';

export const PAGE_SIZES = [25, 50, 100] as const;
/** Rows that can be ticked one by one for an export (the API takes up to 200 ids). */
export const SELECTION_MAX = 200;
/** The API stops page numbers at this row; deeper rows need a filter. */
export const MAX_PAGED_ROWS = 10_000;
/** A payout id is 36 characters; the box takes no more than a pasted id with spaces. */
export const SEARCH_MAX = 64;

/** The views (tabs): every payout, then one for each status, in the order of a payout's life. */
export const VIEWS = ['all', ...PAYOUT_STATUSES] as const;
export type View = (typeof VIEWS)[number];
export const isView = (value: unknown): value is View => VIEWS.some((view) => view === value);
export const statusOfView = (view: View): PayoutStatus | null => (view === 'all' ? null : view);

/** The sorts: the payout day (the default), the amount (page numbers only) and the planned day. */
export const SORTS = ['slot', 'amount', 'created'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';
/** Every sort starts newest (or largest) first, as the API does. */
export const defaultDirection = (): Direction => 'desc';

/**
 * The payout day presets: the shared ones and two that look forward, because this list shows
 * payouts that have not happened yet.
 */
export const PAYOUT_PRESETS = [...DATE_PRESETS, 'next-7-days', 'next-30-days'] as const;
export type PayoutPreset = (typeof PAYOUT_PRESETS)[number];
export const isPayoutPreset = (value: unknown): value is PayoutPreset =>
  PAYOUT_PRESETS.some((preset) => preset === value);

/** The amount steps of the filter, in whole units of the currency. */
export const AMOUNT_STEPS = ['10', '50', '100', '500', '1000', '5000'] as const;
export type AmountStep = (typeof AMOUNT_STEPS)[number];
export const isAmountStep = (value: unknown): value is AmountStep =>
  AMOUNT_STEPS.some((step) => step === value);

export const FILTER_FIELDS = ['payoutOn', 'minAmount', 'maxAmount'] as const;

/** The conditions of the filter panel; each is one value. */
export interface Filters {
  readonly payoutOn?: PayoutPreset;
  readonly minAmount?: AmountStep;
  readonly maxAmount?: AmountStep;
}

export const filterCount = (filters: Filters): number => Object.keys(filters).length;

/** The filters a panel answer holds: only a known value of a known field. */
export function filtersOf(values: Readonly<Record<string, string | undefined>>): Filters {
  const next: { payoutOn?: PayoutPreset; minAmount?: AmountStep; maxAmount?: AmountStep } = {};
  const day = values['payoutOn'];
  if (isPayoutPreset(day)) next.payoutOn = day;
  const min = values['minAmount'];
  if (isAmountStep(min)) next.minAmount = min;
  const max = values['maxAmount'];
  if (isAmountStep(max)) next.maxAmount = max;
  return next;
}

export interface Query {
  readonly view: View;
  /** The search box as typed: a payout id. */
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
  view: 'all',
  q: '',
  filters: {},
  sort: 'slot',
  direction: 'desc',
  page: 1,
  pageSize: PAGE_SIZES[0],
  cursors: [],
};
