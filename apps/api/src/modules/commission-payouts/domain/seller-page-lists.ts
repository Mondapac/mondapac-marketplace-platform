import type { Id, Temporal } from '@mondapac/shared-kernel';
import type { LedgerKind } from './ledger';
import type { HoldOrigin, HoldReason } from './payout-hold';

// The two compact super lists of the admin seller page (super list phase 4, lists 27 and 28):
// the seller's commission ledger and its payout holds. Compact: search, filters, sort, export and
// paging, without views or saved filters (plan: «فهرست داخل صفحه»). Read only; releasing a hold
// keeps its own route, key and step-up.

// --- the ledger (27) ---------------------------------------------------------------------------

export const LEDGER_SORT_KEYS = ['recorded', 'occurred', 'amount'] as const;
export type LedgerSortKey = (typeof LEDGER_SORT_KEYS)[number];

export interface LedgerSort {
  readonly key: LedgerSortKey;
  readonly direction: 'asc' | 'desc';
}

/** Where a Previous/Next page starts: after this row, newest record first. */
export interface LedgerListCursor {
  readonly recordedAt: Temporal.Instant;
  readonly entryId: Id<'LedgerEntry'>;
}

/** Every field is an AND; null leaves it out. Always one seller. */
export interface LedgerListFilter {
  readonly sellerId: Id<'Seller'>;
  /** The kinds shown (a direction is a set of kinds); null: every kind. */
  readonly kinds: readonly LedgerKind[] | null;
  /** An order or seller order id the admin pasted, exact: it matches either. */
  readonly reference: string | null;
  /** Recorded at or after `from`, before `to`. */
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant | null;
  readonly minAmount: bigint | null;
  readonly maxAmount: bigint | null;
}

export const LEDGER_ROW_ACTIONS = ['open-order'] as const;
export type LedgerRowAction = (typeof LEDGER_ROW_ACTIONS)[number];

export const LEDGER_EXPORT_COLUMNS = [
  'occurred',
  'order-line',
  'rate',
  'base',
  'source',
  'entry-id',
] as const;
export type LedgerExportColumn = (typeof LEDGER_EXPORT_COLUMNS)[number];

// --- the payout holds (28) ---------------------------------------------------------------------

export const HOLD_LIST_STATUSES = ['active', 'released'] as const;
export type HoldListStatus = (typeof HOLD_LIST_STATUSES)[number];

/** `active-first` (the default): active holds first, then newest placement first. */
export const HOLD_SORT_KEYS = ['active-first', 'placed', 'released'] as const;
export type HoldSortKey = (typeof HOLD_SORT_KEYS)[number];

export interface HoldSort {
  readonly key: HoldSortKey;
  readonly direction: 'asc' | 'desc';
}

/** Where a Previous/Next page starts: after this hold, newest placement first. */
export interface HoldListCursor {
  readonly placedAt: Temporal.Instant;
  readonly holdId: Id<'PayoutHold'>;
}

export interface HoldListFilter {
  readonly sellerId: Id<'Seller'>;
  readonly status: HoldListStatus | null;
  readonly reason: HoldReason | null;
  readonly origin: HoldOrigin | null;
  /** `seller`: holds over the whole seller; `order`: holds on one seller order. */
  readonly scope: 'seller' | 'order' | null;
  /** A seller order id the admin pasted, exact. */
  readonly sellerOrderId: Id<'SellerOrder'> | null;
  /** Placed at or after `from`, before `to`. */
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant | null;
}

/** The seller's holds per status, whatever the filter. */
export interface HoldStatusCounts {
  readonly active: number;
  readonly released: number;
}

export const HOLD_ROW_ACTIONS = ['open-order', 'release'] as const;
export type HoldRowAction = (typeof HOLD_ROW_ACTIONS)[number];

export const HOLD_EXPORT_COLUMNS = ['release-reason', 'hold-id'] as const;
export type HoldExportColumn = (typeof HOLD_EXPORT_COLUMNS)[number];
