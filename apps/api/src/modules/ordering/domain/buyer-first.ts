import type { Id } from '@mondapac/shared-kernel';

/**
 * Whether a paid seller order was the buyer's first paid order in the Market (`order`), and the
 * buyer's first paid order with its seller (`withSeller`), for the dashboards' new and returning
 * customers (dashboards v2, phase 2). Decided once, in the unit that confirms the payment, from the
 * buyer's claims, and frozen on the seller order. Every seller order of the buyer's first order is
 * first (`order`), and a first order is always the first with its seller.
 */
export interface BuyerFirst {
  readonly order: boolean;
  readonly withSeller: boolean;
}

/**
 * The buyer's claims as stored once the confirming unit has inserted its own (`ON CONFLICT DO
 * NOTHING`): the order the buyer's first-order claim names, and per seller of the order the order
 * the buyer's first claim with that seller names. A claim names the order that won it, which may be
 * another order of the buyer (an earlier one, or one paid concurrently that committed first).
 */
export interface BuyerFirstClaims {
  readonly firstOrderId: Id<'Order'>;
  readonly firstWithSeller: ReadonlyMap<Id<'Seller'>, Id<'Order'>>;
}

/**
 * The flags of each seller order of a confirmed `order`, read from the stored claims. A seller
 * order whose seller has no claim, or whose claims contradict each other (first order, yet not the
 * first with its seller: only a corrupted claim can say so), gets null (unknown, never guessed): a
 * payment is never refused for a reporting attribute. An order not confirmed gets no flags at all.
 */
export function buyerFirstOf(
  order: {
    readonly id: Id<'Order'>;
    readonly status: 'pending-payment' | 'confirmed' | 'cancelled';
    readonly sellerOrders: readonly {
      readonly id: Id<'SellerOrder'>;
      readonly sellerId: Id<'Seller'>;
    }[];
  },
  claims: BuyerFirstClaims,
): ReadonlyMap<Id<'SellerOrder'>, BuyerFirst | null> {
  const flags = new Map<Id<'SellerOrder'>, BuyerFirst | null>();
  if (order.status !== 'confirmed') return flags;
  const first = claims.firstOrderId === order.id;
  for (const sellerOrder of order.sellerOrders) {
    const claimed = claims.firstWithSeller.get(sellerOrder.sellerId);
    if (claimed === undefined) {
      flags.set(sellerOrder.id, null);
      continue;
    }
    const withSeller = claimed === order.id;
    flags.set(sellerOrder.id, first && !withSeller ? null : { order: first, withSeller });
  }
  return flags;
}
