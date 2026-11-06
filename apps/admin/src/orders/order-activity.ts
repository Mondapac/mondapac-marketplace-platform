import type { AdminOrder } from './types.ts';

export type OrderEvent =
  | { readonly kind: 'placed' | 'paid' | 'cancelled'; readonly at: string }
  | {
      readonly kind: 'ready' | 'ready-pickup' | 'shipped' | 'delivered' | 'collected';
      readonly at: string;
      readonly sellerId: string;
      readonly storeName: string | null;
    };

/**
 * What the order already records, oldest first: placed, paid, cancelled, and each seller's ready,
 * shipped and delivered times. Read-only; there is no event log yet, so nothing is invented.
 */
export function orderEvents(order: AdminOrder): readonly OrderEvent[] {
  const events: OrderEvent[] = [{ kind: 'placed', at: order.createdAt }];
  if (order.confirmedAt !== null) events.push({ kind: 'paid', at: order.confirmedAt });
  if (order.cancelledAt !== null) events.push({ kind: 'cancelled', at: order.cancelledAt });
  for (const part of order.sellerOrders) {
    const who = { sellerId: part.sellerId, storeName: part.storeName };
    const pickup = part.deliveryMethod === 'pickup';
    if (part.readyAt !== null) {
      events.push({ kind: pickup ? 'ready-pickup' : 'ready', at: part.readyAt, ...who });
    }
    if (part.shippedAt !== null) events.push({ kind: 'shipped', at: part.shippedAt, ...who });
    if (part.deliveredAt !== null) {
      events.push({ kind: pickup ? 'collected' : 'delivered', at: part.deliveredAt, ...who });
    }
  }
  return events.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
}
