import type { Temporal } from '@mondapac/shared-kernel';
import type {
  RefundReportFacts,
  ReportAmount,
  SellerOrderReportFacts,
} from '../contracts/ordering-reporting.facade';
import { readyByOf, type OrderState, type SellerOrder } from '../domain/order';
import type { Refund } from '../domain/refund';

/**
 * A price with or without its tax as an amount that includes it (dashboards upgrade phase 3).
 * An unknown tax (a line placed before tax was recorded) counts as 0: never guessed.
 */
export function reportAmount(
  net: bigint,
  tax: bigint | null,
  inclusive: boolean | null,
): ReportAmount {
  const known = tax ?? 0n;
  return inclusive === false ? { amount: net + known, tax: known } : { amount: net, tax: known };
}

const compareInstants = (a: Temporal.Instant, b: Temporal.Instant): number =>
  a.epochNanoseconds < b.epochNanoseconds ? -1 : a.epochNanoseconds > b.epochNanoseconds ? 1 : 0;

/**
 * Whether the seller handed the order over (ready, else shipped) by its ready-by promise. Null
 * when it has no promise, or has not been handed over and the promise has not passed yet; false
 * once the promise passed without it.
 */
export function shippedOnTimeOf(
  order: Pick<OrderState, 'confirmedAt'>,
  sellerOrder: Pick<
    SellerOrder,
    'deliveryMethod' | 'deliveryWindow' | 'readyPrepMinutes' | 'readyAt' | 'shippedAt'
  >,
  now: Temporal.Instant,
): boolean | null {
  const by = readyByOf(order, sellerOrder);
  if (by === null) return null;
  const handedOver = sellerOrder.readyAt ?? sellerOrder.shippedAt;
  if (handedOver === null) {
    return compareInstants(now, by) > 0 ? false : null;
  }
  return compareInstants(handedOver, by) <= 0;
}

/** The facts of one seller order of `order`, for reporting. Ids and money only. */
export function sellerOrderReportFacts(
  order: OrderState,
  sellerOrder: SellerOrder,
  now: Temporal.Instant,
): SellerOrderReportFacts {
  return {
    orderId: order.id,
    sellerOrderId: sellerOrder.id,
    sellerId: sellerOrder.sellerId,
    currency: order.total.currency,
    lines: order.lines
      .filter((line) => line.sellerOrderId === sellerOrder.id)
      .map((line) => ({
        offerId: line.offerId,
        quantity: line.quantity,
        goods: reportAmount(
          line.lineAmount - line.discountAmount,
          line.taxAmount,
          line.taxInclusive,
        ),
      })),
    shipping: reportAmount(
      sellerOrder.shipping - sellerOrder.shippingDiscount,
      sellerOrder.shippingTax,
      sellerOrder.shippingTaxInclusive,
    ),
    paidAt: order.status === 'confirmed' ? order.confirmedAt : null,
    cancelledAt: order.status === 'cancelled' ? order.cancelledAt : null,
    shippedAt: sellerOrder.shippedAt,
    shippedOnTime: order.status === 'confirmed' ? shippedOnTimeOf(order, sellerOrder, now) : null,
    deliveredAt: sellerOrder.deliveredAt,
  };
}

/**
 * The facts of one SUCCEEDED refund, for reporting; null for one pending or failed. The Offer of
 * each refunded line comes from its order's lines; a line not found there is left out of the goods
 * lines (its money stays in the totals).
 */
export function refundReportFacts(refund: Refund, order: OrderState): RefundReportFacts | null {
  if (refund.state !== 'succeeded' || refund.settledAt === null) return null;
  const offerOf = new Map(order.lines.map((line) => [line.id, line.offerId] as const));
  const lines = [];
  for (const line of refund.lines) {
    const offerId = offerOf.get(line.orderLineId);
    if (offerId === undefined) continue;
    lines.push({ offerId, quantity: line.quantity, goods: { amount: line.gross, tax: line.tax } });
  }
  return {
    refundId: refund.id,
    orderId: refund.orderId,
    sellerOrderId: refund.sellerOrderId,
    sellerId: refund.sellerId,
    currency: refund.currency,
    total: { amount: refund.gross, tax: refund.tax },
    shipping:
      refund.shipping === null
        ? { amount: 0n, tax: 0n }
        : { amount: refund.shipping.gross, tax: refund.shipping.tax },
    refundedAt: refund.settledAt,
    lines,
  };
}
