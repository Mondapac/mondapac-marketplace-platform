import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';
import type { Known } from './customer-facts';

/**
 * When a delivered seller order's money is released to its seller (commission-payouts' eligibility
 * anchor; customers phase 4c). A real cashback waits for it, so a seller cannot mark its own order
 * delivered and have the credit spent before a refund (Hassan H-1). Known only for a seller order
 * the seller ledger holds; unknown otherwise and on any failure (the caller retries). System actor
 * only.
 */
export interface PayoutAnchors {
  anchorOf(context: CallContext, sellerOrderId: Id<'SellerOrder'>): Promise<Known<PayoutAnchor>>;
}

export interface PayoutAnchor {
  readonly sellerId: Id<'Seller'>;
  readonly eligibleAt: Temporal.Instant;
  /** A payout hold covers the seller order now (a dispute, a suspension): the credit waits. */
  readonly onHold: boolean;
  /** A chargeback took the seller order's money: the credit is cancelled (Hassan M-2). */
  readonly disputeLost: boolean;
}

export const PAYOUT_ANCHORS = Symbol('PROMOTIONS_PAYOUT_ANCHORS');
