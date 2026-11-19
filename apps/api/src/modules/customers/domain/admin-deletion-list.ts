import type { Id, Temporal } from '@mondapac/shared-kernel';
import type {
  AccountDeletionRequestStatus,
  AccountDeletionRequester,
} from './account-deletion-request';

// The admin Account deletion requests list (super list phase 4, list 25; CLAUDE.md rule 14): every
// buyer deletion request of the Market with views, filters, sort, page numbers or Previous/Next,
// the per-view counts, the row Actions menu and the export. It only reads
// `customers.account_deletion_requests`, and never the ticket reference or the admin's reason (free
// text, possible personal data). Cancelling runs through its own use case, with its key and step-up.
// No bulk action but Export exists.

export const DELETION_REQUEST_STATUSES = [
  'pending',
  'executing',
  'cancelled',
  'completed',
] as const satisfies readonly AccountDeletionRequestStatus[];

/** The views (tabs): the older list's pending, the other statuses one by one, and `all`. */
export const DELETION_LIST_VIEWS = [...DELETION_REQUEST_STATUSES, 'all'] as const;
export type DeletionListView = (typeof DELETION_LIST_VIEWS)[number];

export const DELETION_REQUESTERS = [
  'customer',
  'admin',
] as const satisfies readonly AccountDeletionRequester[];

/** Why a request was cancelled: the buyer, a sign-in during the wait, or an admin. */
export const DELETION_CANCEL_REASONS = ['customer', 'sign-in', 'admin'] as const;
export type DeletionCancelReason = (typeof DELETION_CANCEL_REASONS)[number];

export const DELETION_SORT_KEYS = ['scheduled', 'requested', 'cancelled', 'completed'] as const;
export type DeletionSortKey = (typeof DELETION_SORT_KEYS)[number];

export interface DeletionSort {
  readonly key: DeletionSortKey;
  readonly direction: 'asc' | 'desc';
}

/** Where a Previous/Next page starts: after this request, earliest scheduled first (the older list). */
export interface DeletionListCursor {
  readonly scheduledFor: Temporal.Instant;
  readonly id: Id<'AccountDeletionRequest'>;
}

/** Every field is an AND; null leaves it out. */
export interface DeletionListFilter {
  /** The view's status (null: every status). */
  readonly status: AccountDeletionRequestStatus | null;
  readonly requestedBy: AccountDeletionRequester | null;
  readonly cancelReason: DeletionCancelReason | null;
  /** An id the admin pasted: the request's id or the buyer's account id, exact. */
  readonly requestOrAccountId: string | null;
  /** Requested at or after `from`, before `to`. */
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant | null;
  /** Scheduled before this instant. */
  readonly scheduledBefore: Temporal.Instant | null;
}

/** One row: ids, a status and times only; no name, email, ticket or reason. */
export interface DeletionListRow {
  readonly id: Id<'AccountDeletionRequest'>;
  readonly accountId: Id<'Account'>;
  readonly status: AccountDeletionRequestStatus;
  readonly requestedBy: AccountDeletionRequester;
  readonly requestedAt: Temporal.Instant;
  readonly scheduledFor: Temporal.Instant;
  readonly cancelledAt: Temporal.Instant | null;
  readonly cancelReason: DeletionCancelReason | null;
  readonly completedAt: Temporal.Instant | null;
}

export const DELETION_ROW_ACTIONS = ['cancel'] as const;
export type DeletionRowAction = (typeof DELETION_ROW_ACTIONS)[number];

/** The Market's requests per status, whatever the filter: the counts of the views. */
export type DeletionStatusCounts = Readonly<Record<AccountDeletionRequestStatus, number>>;

export function deletionViewCounts(
  counts: DeletionStatusCounts,
): Readonly<Record<DeletionListView, number>> {
  return {
    ...counts,
    all: Object.values(counts).reduce((total, count) => total + count, 0),
  };
}

/** The columns an export may add, in the order the panel's column picker lists them. */
export const DELETION_EXPORT_COLUMNS = ['cancelled', 'cancel-reason', 'completed'] as const;
export type DeletionExportColumn = (typeof DELETION_EXPORT_COLUMNS)[number];
