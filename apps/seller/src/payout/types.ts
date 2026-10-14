// Answers of the seller payout-account routes (apps/api payments/seller/payout-account).

export const PAYOUT_VIEW_PERMISSION = 'payments.payout-account.view';
export const PAYOUT_MANAGE_PERMISSION = 'payments.payout-account.manage';

export const STATUSES = [
  'not-connected',
  'not-started',
  'pending',
  'enabled',
  'restricted',
  'rejected',
] as const;
export type PayoutStatus = (typeof STATUSES)[number];

export const CHANGE_KINDS = ['initial', 'added', 'updated', 'removed'] as const;

export interface PayoutChange {
  readonly detectedAt: string;
  readonly kind: string;
}

export interface PayoutAccount {
  readonly status: string;
  readonly ready: boolean;
  readonly requirementsDue: number;
  readonly requirementsPastDue: boolean;
  /** The signed-in Seller Owner has two-step sign-in on. */
  readonly secondFactorActive: boolean;
  /** An instant while a waiting period after a bank-account change runs. */
  readonly coolingOffUntil: string | null;
  readonly payoutsPaused: boolean;
  /** Newest first, at most 10. */
  readonly changes: readonly PayoutChange[];
}

/** Answer of the two POST routes: the account and the one-time Stripe address. */
export interface PayoutLink extends PayoutAccount {
  readonly url: string;
}

export type StripeReturn = 'return' | 'refresh' | null;
