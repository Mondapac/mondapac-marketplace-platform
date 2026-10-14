// Answers of GET payments/admin/connected-accounts (read-only; no Stripe id or bank detail).

export const VIEW_PERMISSION = 'payments.connected-account.view';
export const PAGE_SIZE = 25;

export const STATUSES = [
  'not-connected',
  'not-started',
  'pending',
  'enabled',
  'restricted',
  'rejected',
] as const;
export type AccountStatus = (typeof STATUSES)[number];
/** The filter: one status, or every account. */
export type StatusFilter = AccountStatus | 'all';
export const FILTERS: readonly StatusFilter[] = ['all', ...STATUSES];

export const CHANGE_KINDS = ['initial', 'added', 'updated', 'removed'] as const;

export interface ConnectedAccountRow {
  readonly sellerId: string;
  readonly sellerName: string | null;
  readonly status: string;
  readonly ready: boolean;
  readonly requirementsDue: number;
  readonly requirementsPastDue: boolean;
  readonly coolingOffUntil: string | null;
  readonly payoutsPaused: boolean;
  readonly lastReadAt: string | null;
  readonly createdAt: string;
}

export interface ConnectedAccountChange {
  readonly detectedAt: string;
  readonly kind: string;
}

export interface ConnectedAccountDetail extends ConnectedAccountRow {
  readonly changes: readonly ConnectedAccountChange[];
}

export interface ConnectedAccountPage {
  readonly items: readonly ConnectedAccountRow[];
  readonly nextCursor: string | null;
}
