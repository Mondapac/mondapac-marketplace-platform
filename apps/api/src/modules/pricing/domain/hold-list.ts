import type { Id, Temporal } from '@mondapac/shared-kernel';

// The admin price-hold list (super list phase 3, list 19; CLAUDE.md rule 14): every held record of
// the Market with views, filters, sort, page numbers or Previous/Next, the view counts, the row
// Actions menu and the export. It only reads the pending records; approving or rejecting runs
// through its own use cases with the protected `pricing.price-hold.decide` key.

/** The views (tabs): every held record, one stream, or one direction. */
export const HOLD_LIST_VIEWS = ['all', 'regular', 'special', 'up', 'down'] as const;
export type HoldListView = (typeof HOLD_LIST_VIEWS)[number];

export const HOLD_SORT_KEYS = ['submitted', 'amount'] as const;
export type HoldSortKey = (typeof HOLD_SORT_KEYS)[number];

export interface HoldSort {
  readonly key: HoldSortKey;
  readonly direction: 'asc' | 'desc';
}

/** Every field is an AND; null leaves it out. */
export interface HoldListFilter {
  readonly kind: 'regular' | 'special' | null;
  readonly direction: 'up' | 'down' | null;
  readonly sellerId: Id<'Seller'> | null;
  /** An id the admin pasted: the record's id or its Offer's id, exact. */
  readonly recordOrOfferId: string | null;
  /** Submitted at or after `from`, before `to`. */
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant | null;
  /** The held amount in minor units, both ends included. */
  readonly minAmount: bigint | null;
  readonly maxAmount: bigint | null;
}

export const EMPTY_HOLD_FILTER: HoldListFilter = Object.freeze({
  kind: null,
  direction: null,
  sellerId: null,
  recordOrOfferId: null,
  from: null,
  to: null,
  minAmount: null,
  maxAmount: null,
});

/** The Market's held records per view, whatever the filter. */
export type HoldViewCounts = Readonly<Record<HoldListView, number>>;

export const HOLD_ROW_ACTIONS = ['open', 'decide'] as const;
export type HoldRowAction = (typeof HOLD_ROW_ACTIONS)[number];

/** The columns an export may add, in the order the panel's column picker lists them. */
export const HOLD_EXPORT_COLUMNS = [
  'offer-id',
  'variant-id',
  'seller-id',
  'record-id',
  'window',
  'anchor',
] as const;
export type HoldExportColumn = (typeof HOLD_EXPORT_COLUMNS)[number];

/** The view's filter: a view is a shortcut for one `kind` or `direction`. */
export function viewFilter(view: HoldListView): Pick<HoldListFilter, 'kind' | 'direction'> {
  switch (view) {
    case 'all':
      return { kind: null, direction: null };
    case 'regular':
    case 'special':
      return { kind: view, direction: null };
    case 'up':
    case 'down':
      return { kind: null, direction: view };
  }
}

/** The minimum of what {@link holdMatches} reads of a held record. */
export interface HoldFilterSubject {
  readonly kind: 'regular' | 'special';
  readonly direction: 'up' | 'down';
  readonly recordId: string;
  readonly offerId: string;
  readonly sellerId: string;
  readonly amount: { readonly amount: bigint };
  readonly submittedAt: Temporal.Instant;
}

/** Whether a record meets a filter; the in-memory twin of the repository's `where`. */
export function holdMatches(hold: HoldFilterSubject, filter: HoldListFilter): boolean {
  if (filter.kind !== null && hold.kind !== filter.kind) return false;
  if (filter.direction !== null && hold.direction !== filter.direction) return false;
  if (filter.sellerId !== null && hold.sellerId !== filter.sellerId) return false;
  if (
    filter.recordOrOfferId !== null &&
    hold.recordId !== filter.recordOrOfferId &&
    hold.offerId !== filter.recordOrOfferId
  ) {
    return false;
  }
  const at = hold.submittedAt.epochMilliseconds;
  if (filter.from !== null && at < filter.from.epochMilliseconds) return false;
  if (filter.to !== null && at >= filter.to.epochMilliseconds) return false;
  if (filter.minAmount !== null && hold.amount.amount < filter.minAmount) return false;
  if (filter.maxAmount !== null && hold.amount.amount > filter.maxAmount) return false;
  return true;
}

/** Sorts two records; the record id breaks every tie, so a page boundary never repeats a row. */
export function compareHolds(a: HoldFilterSubject, b: HoldFilterSubject, sort: HoldSort): number {
  const sign = sort.direction === 'asc' ? 1 : -1;
  const primary =
    sort.key === 'submitted'
      ? a.submittedAt.epochMilliseconds - b.submittedAt.epochMilliseconds
      : a.amount.amount < b.amount.amount
        ? -1
        : a.amount.amount > b.amount.amount
          ? 1
          : 0;
  if (primary !== 0) return sign * primary;
  return sign * (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0);
}
