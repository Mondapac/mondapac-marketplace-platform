// The review moderation list as a super list (list 18): the answer of GET
// reviews/admin/moderation/list (apps/api reviews.dto.ts, `ModerationListBody`) and the list's own
// state. One row per review in a moderation view. The author is never in a row.

import type { ListPagingMode } from '../../sales/cursor-paging.ts';
import { isDatePreset, type DatePreset } from '../../sales/date-presets.ts';
import type { ReviewRow } from '../types.ts';

export const PAGE_SIZE = 25;
/** Rows that can be ticked one by one for an export (the API takes up to 200 ids). */
export const SELECTION_MAX = 200;
/** The API's longest search text (a review, Offer or product id, or words of the review). */
export const SEARCH_MAX = 100;

/** The views: every review in any queue, then the three queues. */
export const VIEWS = ['all', 'held', 'reported', 'actioned'] as const;
export type View = (typeof VIEWS)[number];

export const SORTS = ['submitted', 'rating'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';
/** Newest first; lowest rating first (the angriest reviews are often the ones to look at). */
export const defaultDirection = (sort: Sort): Direction => (sort === 'submitted' ? 'desc' : 'asc');

/** The row actions the API names, in the order the menu shows them; one it does not know is ignored. */
export const ROW_ACTIONS = [
  'open',
  'publish',
  'restore',
  'dismiss-reports',
  'hide',
  'remove',
] as const;
export type RowAction = (typeof ROW_ACTIONS)[number];

export interface ModerationListRow extends ReviewRow {
  readonly actions: readonly string[];
}

export type ModerationCounts = Readonly<Record<View, number>>;

export interface ModerationListPage {
  readonly items: readonly ModerationListRow[];
  /** Null with Previous and next. */
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  readonly hasNext: boolean;
  readonly counts: ModerationCounts;
}

export const FILTER_FIELDS = ['minRating', 'maxRating', 'reportReason', 'submitted'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

export const RATINGS = ['1', '2', '3', '4', '5'] as const;
export type Rating = (typeof RATINGS)[number];

/**
 * The reasons a review can be reported for: a shop reports a review of it with one of these (the
 * API's closed list, `SELLER_REPORT_REASONS`, which the saved-filter document also takes).
 */
export const REPORT_REASONS: readonly string[] = [
  'personal-information',
  'abusive',
  'irrelevant',
  'not-a-purchase',
  'extortion',
];

/** The conditions of the filter panel; each is one value. */
export interface Filters {
  readonly minRating?: Rating;
  readonly maxRating?: Rating;
  readonly reportReason?: string;
  readonly submitted?: DatePreset;
}

export const filterCount = (filters: Filters): number => Object.keys(filters).length;

const isRating = (value: unknown): value is Rating => RATINGS.some((rating) => rating === value);

/**
 * The filters a panel answer (or a saved filter) holds: only a known value of a known field. A
 * range that ends before it starts is turned around, so the API is never asked for nothing.
 */
export function filtersOf(values: Readonly<Record<string, string>>): Filters {
  const next: { -readonly [K in keyof Filters]: Filters[K] } = {};
  const min = values['minRating'];
  const max = values['maxRating'];
  if (isRating(min)) next.minRating = min;
  if (isRating(max)) next.maxRating = max;
  if (
    next.minRating !== undefined &&
    next.maxRating !== undefined &&
    next.minRating > next.maxRating
  ) {
    [next.minRating, next.maxRating] = [next.maxRating, next.minRating];
  }
  const reason = values['reportReason'];
  if (reason !== undefined && REPORT_REASONS.includes(reason)) next.reportReason = reason;
  const submitted = values['submitted'];
  if (isDatePreset(submitted)) next.submitted = submitted;
  return next;
}

export interface Query {
  readonly view: View;
  /** A review, Offer or product id, or words of the title or review, as typed and trimmed. */
  readonly q: string;
  readonly filters: Filters;
  /** One seller's reviews, from a link (`?sellerId=`); the panel has no picker for it. */
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
  sort: 'submitted',
  direction: 'desc',
  page: 1,
};
