import type { AdminOrderDetail, Refund, SellerPart } from './types.ts';

// What is left to give back on an order, read from its refunds (order detail decision 1). The API
// checks every amount again; these only shape the dialogs. A failed refund gave nothing back, so
// it does not count; a pending one does (Stripe may still pay it).

const counts = (refund: Refund): boolean => refund.state !== 'failed';

/** The refunds of one seller order, newest first as the API lists them. */
export function refundsOf(order: AdminOrderDetail, part: SellerPart): readonly Refund[] {
  return order.refunds.filter((refund) => refund.sellerOrderId === part.sellerOrderId);
}

/** Units of each line not yet given back, by line id. */
export function unitsLeft(
  part: SellerPart,
  refunds: readonly Refund[],
): ReadonlyMap<string, number> {
  const given = new Map<string, number>();
  for (const refund of refunds.filter(counts)) {
    for (const line of refund.lines) {
      given.set(line.orderLineId, (given.get(line.orderLineId) ?? 0) + line.quantity);
    }
  }
  return new Map(
    part.lines.map((line) => [
      line.lineId,
      Math.max(0, line.quantity - (given.get(line.lineId) ?? 0)),
    ]),
  );
}

/** The shipping already given back, in minor units (tax included, as the refund route takes it). */
export function shippingGiven(refunds: readonly Refund[]): bigint {
  return refunds
    .filter(counts)
    .reduce(
      (sum, refund) =>
        sum + (refund.shipping === null ? 0n : BigInt(refund.shipping.amount.amount)),
      0n,
    );
}

/** Whether a refund of the seller order is still waiting for Stripe. */
export const pendingOf = (refunds: readonly Refund[]): boolean =>
  refunds.some((refund) => refund.state === 'pending');

/**
 * The delivery fee still to give back, in minor units: the fee as paid less what refunds gave.
 * Zero when the fee was free or its tax was not recorded (the API refuses such a fee).
 */
export function shippingLeft(part: SellerPart, refunds: readonly Refund[]): bigint {
  if (part.shippingGross === null) return 0n;
  const left = BigInt(part.shippingGross.amount) - shippingGiven(refunds);
  return left > 0n ? left : 0n;
}

/** Whether nothing of the seller order is left to give back: no unit and no delivery fee. */
export function fullyRefunded(part: SellerPart, refunds: readonly Refund[]): boolean {
  const units = [...unitsLeft(part, refunds).values()].every((left) => left === 0);
  return units && shippingLeft(part, refunds) === 0n;
}

export type CancelBlock = 'disabled' | 'not-paid' | 'too-late' | 'in-progress' | 'nothing-left';

/**
 * Why the whole order cannot be cancelled now, or null when it can: the switch is on, it is paid
 * and captured, no seller has started (every part to ship and not ready), no refund is waiting
 * and something is left. The same order as the API's checks, so the reason shown is the one the
 * API would give.
 */
export function cancelBlock(order: AdminOrderDetail): CancelBlock | null {
  if (!order.refundsEnabled) return 'disabled';
  if (
    order.status !== 'confirmed' ||
    order.paymentState !== 'captured' ||
    order.sellerOrders.length === 0
  ) {
    return 'not-paid';
  }
  if (order.sellerOrders.some((part) => part.fulfilment !== 'to-ship' || part.readyAt !== null)) {
    return 'too-late';
  }
  if (pendingOf(order.refunds)) return 'in-progress';
  if (order.sellerOrders.every((part) => fullyRefunded(part, refundsOf(order, part)))) {
    return 'nothing-left';
  }
  return null;
}

/** Why one seller order cannot be refunded now, or null when it can. */
export function refundBlock(
  order: AdminOrderDetail,
  part: SellerPart,
): Exclude<CancelBlock, 'too-late'> | null {
  if (!order.refundsEnabled) return 'disabled';
  if (order.status !== 'confirmed' || order.paymentState !== 'captured') return 'not-paid';
  const refunds = refundsOf(order, part);
  if (pendingOf(refunds)) return 'in-progress';
  return fullyRefunded(part, refunds) ? 'nothing-left' : null;
}
