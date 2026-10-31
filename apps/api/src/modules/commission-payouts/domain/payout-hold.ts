// Payout holds (Phase 5 package 6b; G2 3.5). A hold covers a whole seller or one of its seller
// orders and blocks payouts until released. Insert and release only; the system never releases a
// `seller-suspended` hold, only an admin does.

export const HOLD_REASONS = [
  'seller-suspended',
  'refund-pending',
  'dispute',
  'admin-review',
  'bank-change',
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/** The reasons an admin may place by hand; the others are placed by the system from events. */
export const ADMIN_HOLD_REASONS = ['admin-review', 'bank-change'] as const;
export type AdminHoldReason = (typeof ADMIN_HOLD_REASONS)[number];

export const RELEASE_REASONS = [
  'resolved',
  'placed-in-error',
  'seller-reinstated',
  'review-complete',
] as const;
export type ReleaseReason = (typeof RELEASE_REASONS)[number];

export type HoldOrigin = 'admin' | 'system';

/**
 * What a seller is told about a hold on its money (design 5.4, Q-S4): `refund-pending` as such,
 * every other reason (a suspension, a dispute, an admin review, a bank change) only as the generic
 * `on-hold`, so the seller contacts support. One mapping, used by every seller-facing read.
 */
export type SellerVisibleHoldReason = 'on-hold' | 'refund-pending';

export const sellerVisibleHoldReason = (reason: HoldReason): SellerVisibleHoldReason =>
  reason === 'refund-pending' ? 'refund-pending' : 'on-hold';
