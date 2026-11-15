import { money } from '@mondapac/shared-kernel';
import type { SellerOrderRefundView } from './order-views';
import type { Refund } from './refund';

/** A refund as the seller order's own page shows it (no account, Stripe id or loss reason code). */
export function sellerOrderRefundView(refund: Refund): SellerOrderRefundView {
  return {
    refundId: refund.id,
    requestedBy: refund.actor.population,
    state: refund.state,
    reason: refund.reason,
    amount: money(refund.gross, refund.currency),
    shipping: refund.shipping === null ? null : money(refund.shipping.gross, refund.currency),
    lines: refund.lines.map((line) => ({ orderLineId: line.orderLineId, quantity: line.quantity })),
    requestedAt: refund.requestedAt,
    settledAt: refund.settledAt,
  };
}
