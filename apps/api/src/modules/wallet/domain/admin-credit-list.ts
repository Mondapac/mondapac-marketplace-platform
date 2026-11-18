import type { Id, Temporal } from '@mondapac/shared-kernel';
import type { AdminCreditReason, AdminCreditStatus, ApprovalReason } from './admin-credit';

// The admin Credit requests list (super list phase 4, list 24; CLAUDE.md rule 14): every admin
// credit issue and request of the Market with views, search, filters, sort, page numbers or
// Previous/Next, the per-view counts, the row Actions menu and the export. It only reads
// `wallet.admin_credit_requests`; approving and rejecting run through their own use cases, which
// check the key, the four-eyes rule and the expiry again. No bulk money action exists: the only
// bulk action is Export.

/** The views (tabs) and the statuses each one shows; the older queue's three plus `all`. */
export const CREDIT_LIST_VIEWS = ['pending', 'decided', 'granted', 'all'] as const;
export type CreditListView = (typeof CREDIT_LIST_VIEWS)[number];

export const CREDIT_VIEW_STATUSES: Readonly<
  Record<Exclude<CreditListView, 'all'>, readonly AdminCreditStatus[]>
> = Object.freeze({
  pending: ['pending'],
  decided: ['approved', 'rejected', 'expired'],
  granted: ['granted'],
});

export const CREDIT_SORT_KEYS = ['requested', 'amount', 'expires', 'decided'] as const;
export type CreditSortKey = (typeof CREDIT_SORT_KEYS)[number];

export interface CreditSort {
  readonly key: CreditSortKey;
  readonly direction: 'asc' | 'desc';
}

/** Where a Previous/Next page starts: after this request, newest first. */
export interface CreditListCursor {
  readonly requestedAt: Temporal.Instant;
  readonly id: Id<'WalletCreditRequest'>;
}

/** Every field is an AND; null leaves it out. */
export interface CreditListFilter {
  /** The statuses of the view (null: every status). */
  readonly statuses: readonly AdminCreditStatus[] | null;
  /** One status, inside the view. */
  readonly status: AdminCreditStatus | null;
  readonly reason: AdminCreditReason | null;
  readonly approvalReason: ApprovalReason | null;
  /** An id the admin pasted: the request's id or its customer's account id, exact. */
  readonly requestOrCustomerId: string | null;
  readonly requestedBy: Id<'Account'> | null;
  /** Requested at or after `from`, before `to`. */
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant | null;
  /** The amount in minor units of the Market's currency, both ends included. */
  readonly minAmount: bigint | null;
  readonly maxAmount: bigint | null;
}

export const CREDIT_ROW_ACTIONS = ['open', 'approve', 'reject'] as const;
export type CreditRowAction = (typeof CREDIT_ROW_ACTIONS)[number];

/** The Market's requests per status, whatever the filter: the counts of the views. */
export type CreditStatusCounts = Readonly<Record<AdminCreditStatus, number>>;

export function creditViewCounts(
  counts: CreditStatusCounts,
): Readonly<Record<CreditListView, number>> {
  const sum = (statuses: readonly AdminCreditStatus[]) =>
    statuses.reduce((total, status) => total + counts[status], 0);
  return {
    pending: sum(CREDIT_VIEW_STATUSES.pending),
    decided: sum(CREDIT_VIEW_STATUSES.decided),
    granted: sum(CREDIT_VIEW_STATUSES.granted),
    all: Object.values(counts).reduce((total, count) => total + count, 0),
  };
}

/** The columns an export may add, in the order the panel's column picker lists them. */
export const CREDIT_EXPORT_COLUMNS = [
  'note',
  'approval-reason',
  'expires',
  'decided-by',
  'decided',
  'decision-reason',
  'journal',
] as const;
export type CreditExportColumn = (typeof CREDIT_EXPORT_COLUMNS)[number];
