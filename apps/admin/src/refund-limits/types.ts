// Answers of the admin routes for the caps on seller refunds (apps/api ordering
// admin-refund-limits.controller.ts). Reading needs `ordering.refund-limits.view`; every change
// needs the protected `ordering.refund-limits.manage`.

export const REFUND_LIMITS_VIEW_PERMISSION = 'ordering.refund-limits.view';
export const REFUND_LIMITS_MANAGE_PERMISSION = 'ordering.refund-limits.manage';
export const REFUND_LIMITS_PATH = 'ordering/admin/refund-limits';
/** The most refunds in 24 hours the API accepts (MAX_REFUND_LIMIT_COUNT). */
export const MAX_COUNT = 1000;

export const sellerLimitsPath = (sellerId: string) => `${REFUND_LIMITS_PATH}/sellers/${sellerId}`;
export const sellerReadPath = (sellerId: string) => `${REFUND_LIMITS_PATH}?sellerId=${sellerId}`;

export interface RefundLimit {
  readonly maxCount: number;
  /** Minor units as a decimal string, with the Market currency. */
  readonly maxAmount: { readonly amount: string; readonly currency: string };
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface RefundLimits {
  readonly currency: string;
  readonly marketDefault: RefundLimit | null;
  readonly sellerId?: string | null;
  readonly own: RefundLimit | null;
  /** Which cap applies; `none` refuses every seller refund. */
  readonly inForce: 'own' | 'market' | 'none';
}
