// Answers of the admin payout terms and holds routes of one seller (package 6b).

export const TERMS_VIEW_PERMISSION = 'commission-payouts.payout-terms.view';
export const TERMS_EDIT_PERMISSION = 'commission-payouts.payout-terms.edit';
export const HOLD_VIEW_PERMISSION = 'commission-payouts.settlement.view';
export const HOLD_PLACE_PERMISSION = 'commission-payouts.payout-hold.place';
export const HOLD_RELEASE_PERMISSION = 'commission-payouts.payout-hold.release';

export const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const APPROVAL_MODES = ['AUTO', 'MANUAL'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
/** Why an admin changes a seller's terms: a closed list, no free text. */
export const TERMS_REASONS = ['seller-request', 'risk-review', 'correction', 'policy'] as const;
export const HOLD_DAYS_MIN = 7;
export const HOLD_DAYS_MAX = 60;

export interface TermsValues {
  readonly weekdays: readonly string[];
  readonly localTime: string;
  readonly holdDaysCarrier: number;
  readonly holdDaysSellerClick: number;
  /** Minor units of the Market currency. */
  readonly minimumMinor: string;
  readonly approvalMode: string;
  readonly firstPayoutManual: boolean;
}

export interface TermsOverride {
  readonly weekdays: readonly string[] | null;
  readonly localTime: string | null;
  readonly holdDaysCarrier: number | null;
  readonly holdDaysSellerClick: number | null;
  readonly minimumMinor: string | null;
  readonly approvalMode: string | null;
}

export interface PayoutTerms {
  readonly sellerId: string;
  readonly source: 'seller' | 'market';
  readonly effective: TermsValues;
  readonly override: TermsOverride | null;
  /** The override version to send back as `expectedVersion`; null without an override. */
  readonly version: number | null;
}

export const HOLD_REASONS = [
  'seller-suspended',
  'refund-pending',
  'dispute',
  'admin-review',
  'bank-change',
] as const;
export const ADMIN_HOLD_REASONS = ['admin-review', 'bank-change'] as const;
export const RELEASE_REASONS = [
  'resolved',
  'placed-in-error',
  'seller-reinstated',
  'review-complete',
] as const;

export interface PayoutHold {
  readonly holdId: string;
  readonly sellerId: string;
  readonly sellerOrderId: string | null;
  readonly reason: string;
  readonly origin: 'admin' | 'system';
  readonly placedAt: string;
  readonly active: boolean;
  readonly releasedAt: string | null;
  readonly releaseReason: string | null;
}

/**
 * A hold an admin may release: one an admin placed, and a suspended seller's (the system never
 * releases that one). The system's own holds (a dispute, a refund, a bank-change waiting period)
 * end by themselves, so no button stands in the way of that.
 */
export const canReleaseHold = (hold: PayoutHold): boolean =>
  hold.active && (hold.origin === 'admin' || hold.reason === 'seller-suspended');
