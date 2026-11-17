import type { Temporal } from '@mondapac/shared-kernel';
import type { AccountStatus } from './connected-account';

// The admin Seller accounts list (super list phase 4, list 22): its sorts, filters, row actions
// and export columns. Read only: no action on this list moves money or changes an account.

export const ACCOUNT_SORT_KEYS = ['created', 'last-read', 'requirements'] as const;
export type AccountSortKey = (typeof ACCOUNT_SORT_KEYS)[number];

export interface AccountSort {
  readonly key: AccountSortKey;
  readonly direction: 'asc' | 'desc';
}

/** `past-due`: Stripe lists details that are already late; `due`: any listed; `none`: nothing. */
export const ACCOUNT_REQUIREMENT_FILTERS = ['past-due', 'due', 'none'] as const;
export type AccountRequirementFilter = (typeof ACCOUNT_REQUIREMENT_FILTERS)[number];

/** `cooling-off`: inside the waiting period after a bank change; `paused`: Stripe payouts kept manual. */
export const ACCOUNT_WAITING_FILTERS = ['cooling-off', 'paused'] as const;
export type AccountWaitingFilter = (typeof ACCOUNT_WAITING_FILTERS)[number];

export interface AccountListFilter {
  readonly status: AccountStatus | null;
  /** Ready for payouts (enabled and outside the waiting period) or not; null = either. */
  readonly ready: boolean | null;
  readonly requirements: AccountRequirementFilter | null;
  readonly waiting: AccountWaitingFilter | null;
  /** One seller, exact (a search by seller id). */
  readonly sellerId: string | null;
  /** The sellers a store-name search found; null = no search. */
  readonly sellerIds: readonly string[] | null;
  /** On the creation instant: from inclusive, to exclusive. */
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant | null;
  /** The instant `ready` and `waiting` are judged at (the clock, never the caller). */
  readonly now: Temporal.Instant;
}

export const ACCOUNT_ROW_ACTIONS = ['open'] as const;
export type AccountRowAction = (typeof ACCOUNT_ROW_ACTIONS)[number];

export const ACCOUNT_EXPORT_COLUMNS = ['cooling-off', 'paused', 'last-read', 'seller-id'] as const;
export type AccountExportColumn = (typeof ACCOUNT_EXPORT_COLUMNS)[number];
