import type { Id, Temporal } from '@mondapac/shared-kernel';
import type { PayoutState } from './payout';
import type { ApprovalMode } from './payout-terms';

// The admin Payouts list (super list phase 4, list 21; CLAUDE.md rule 14): every payout of the
// Market, one row per payout, with views, search, filters, sort, page numbers or Previous/Next,
// the per-view counts, the row Actions menu and the export. It only reads
// `commission_payouts.payouts` (and the active admin holds of the sellers on the page); every
// action runs through its own use case, which checks its key and step-up again. No bulk money
// action exists: the only bulk action is Export.

/**
 * The views (tabs) of the list and the states each one shows. A voided payout never happened and
 * a payout settled by netting sent no transfer: they show under `all` only.
 */
export const PAYOUT_LIST_VIEWS = [
  'all',
  'awaiting-approval',
  'sending',
  'paid',
  'failed',
  'not-sent',
] as const;
export type PayoutListView = (typeof PAYOUT_LIST_VIEWS)[number];

export const PAYOUT_VIEW_STATES: Readonly<
  Record<Exclude<PayoutListView, 'all'>, readonly PayoutState[]>
> = Object.freeze({
  'awaiting-approval': ['awaiting-approval'],
  sending: ['approved', 'instructing', 'instructed'],
  paid: ['paid'],
  failed: ['failed'],
  'not-sent': ['not-sent'],
});

export const PAYOUT_SORT_KEYS = ['created', 'amount', 'state-changed', 'slot'] as const;
export type PayoutSortKey = (typeof PAYOUT_SORT_KEYS)[number];

export interface PayoutSort {
  readonly key: PayoutSortKey;
  readonly direction: 'asc' | 'desc';
}

/** Where a Previous/Next page starts: after this payout, newest first. */
export interface PayoutListCursor {
  readonly createdAt: Temporal.Instant;
  readonly payoutId: Id<'Payout'>;
}

/** Where a Previous/Next page by payout day starts: after this payout, latest slot first. */
export interface PayoutSlotCursor {
  readonly slotAt: Temporal.Instant;
  readonly payoutId: Id<'Payout'>;
}

/** Every field is an AND; null leaves it out. */
export interface PayoutListFilter {
  /** The states of the view (null: every state). */
  readonly states: readonly PayoutState[] | null;
  /** One state, inside the view. */
  readonly state: PayoutState | null;
  /** A payout id the admin pasted, exact. */
  readonly payoutId: Id<'Payout'> | null;
  readonly sellerId: Id<'Seller'> | null;
  readonly approvalMode: ApprovalMode | null;
  /**
   * The date `from` and `to` compare: `created` (absent: the admin list) or `slot` (the payout
   * day, the seller's own list).
   */
  readonly dateOn?: 'created' | 'slot';
  /** At or after `from`, before `to`, on the date `dateOn` names. */
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant | null;
  /** The transfer in minor units of the Market's currency, both ends included. */
  readonly minAmount: bigint | null;
  readonly maxAmount: bigint | null;
  /** The sellers whose store name matched the search; null without a search, empty: none. */
  readonly sellerIds: readonly Id<'Seller'>[] | null;
}

export const PAYOUT_ROW_ACTIONS = ['open', 'approve', 'place-hold', 'release-hold'] as const;
export type PayoutRowAction = (typeof PAYOUT_ROW_ACTIONS)[number];

/** A payout with what the row actions need to know of its seller. */
export interface PayoutActionSubject {
  readonly state: PayoutState;
  /** The seller's active admin hold over the whole seller, newest; null when there is none. */
  readonly activeHoldId: Id<'PayoutHold'> | null;
}

/** A hold stops a payout that has not reached payments yet. */
export const HOLDABLE_STATES: readonly PayoutState[] = ['pending', 'awaiting-approval', 'approved'];

/** The Market's payouts per state, whatever the filter: the counts of the views. */
export type PayoutStateCounts = Readonly<Record<PayoutState, number>>;

/** The count of each view, from the per-state counts. */
export function viewCounts(counts: PayoutStateCounts): Readonly<Record<PayoutListView, number>> {
  const sum = (states: readonly PayoutState[]) =>
    states.reduce((total, state) => total + counts[state], 0);
  return {
    all: Object.values(counts).reduce((total, count) => total + count, 0),
    'awaiting-approval': sum(PAYOUT_VIEW_STATES['awaiting-approval']),
    sending: sum(PAYOUT_VIEW_STATES.sending),
    paid: sum(PAYOUT_VIEW_STATES.paid),
    failed: sum(PAYOUT_VIEW_STATES.failed),
    'not-sent': sum(PAYOUT_VIEW_STATES['not-sent']),
  };
}

/** The columns an export may add, in the order the panel's column picker lists them. */
export const PAYOUT_EXPORT_COLUMNS = [
  'gross',
  'netted',
  'approval-mode',
  'approval-reason',
  'slot',
  'state-changed',
  'outcome',
  'seller-id',
] as const;
export type PayoutExportColumn = (typeof PAYOUT_EXPORT_COLUMNS)[number];
