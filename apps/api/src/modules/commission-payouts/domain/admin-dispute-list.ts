import type { Id, Temporal } from '@mondapac/shared-kernel';
import {
  DISPUTE_BUCKETS,
  type DisputeBucket,
  type DisputeMoneyState,
  type DisputeStatus,
} from './dispute';

// The admin Disputes list (super list phase 4, list 23; CLAUDE.md rule 14): every dispute case of
// the Market with views (the buckets), search, filters, sort, page numbers or Previous/Next, the
// bucket counts, the row Actions menu and the export. It only reads
// `commission_payouts.dispute_cases` (and the ledger's seller orders of the cases on a page or of
// a seller filter); the decision runs through its own use case with its key and step-up. No bulk
// money action exists: the only bulk action is Export.

/** The views (tabs): every case, or one bucket. */
export const DISPUTE_LIST_VIEWS = ['all', ...DISPUTE_BUCKETS] as const;
export type DisputeListView = (typeof DISPUTE_LIST_VIEWS)[number];

export const DISPUTE_MONEY_STATES: readonly DisputeMoneyState[] = [
  'withdrawn',
  'inquiry',
  'reinstated',
  'none',
];

export const DISPUTE_SORT_KEYS = ['opened', 'amount', 'evidence-due', 'updated'] as const;
export type DisputeSortKey = (typeof DISPUTE_SORT_KEYS)[number];

export interface DisputeSort {
  readonly key: DisputeSortKey;
  readonly direction: 'asc' | 'desc';
}

/** Where a Previous/Next page starts: after this case, newest opened first. */
export interface DisputeListCursor {
  readonly openedAt: Temporal.Instant;
  readonly disputeId: Id<'Dispute'>;
}

/** Every field is an AND; null leaves it out. */
export interface DisputeListFilter {
  readonly bucket: DisputeBucket | null;
  /** Stripe's status of the dispute. */
  readonly status: DisputeStatus | null;
  /** What the money is doing now (the list's Money column), as `moneyStateOf` says. */
  readonly moneyState: DisputeMoneyState | null;
  /** An id the admin pasted: the case's id or its order's id, exact. */
  readonly caseOrOrderId: string | null;
  /** Opened at or after `from`, before `to`. */
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant | null;
  /** The evidence is due before this instant (a case without a deadline never matches). */
  readonly dueBefore: Temporal.Instant | null;
  /** The disputed amount in minor units, both ends included. */
  readonly minAmount: bigint | null;
  readonly maxAmount: bigint | null;
  /**
   * The orders of the seller filter or of the store search (the ledger's seller orders of the
   * Market's disputed orders); null without one, empty: none.
   */
  readonly orderIds: readonly Id<'Order'>[] | null;
}

export const DISPUTE_ROW_ACTIONS = ['open', 'decide'] as const;
export type DisputeRowAction = (typeof DISPUTE_ROW_ACTIONS)[number];

/** The Market's cases per bucket, whatever the filter: the counts of the views. */
export type DisputeBucketCounts = Readonly<Record<DisputeBucket, number>>;

export function disputeViewCounts(
  counts: DisputeBucketCounts,
): Readonly<Record<DisputeListView, number>> {
  return {
    all: DISPUTE_BUCKETS.reduce((total, bucket) => total + counts[bucket], 0),
    ...counts,
  };
}

/** The columns an export may add, in the order the panel's column picker lists them. */
export const DISPUTE_EXPORT_COLUMNS = [
  'reason',
  'stripe-status',
  'money',
  'evidence-due',
  'closed',
  'updated',
  'seller-ids',
] as const;
export type DisputeExportColumn = (typeof DISPUTE_EXPORT_COLUMNS)[number];
