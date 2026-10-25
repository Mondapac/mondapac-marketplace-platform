import type {
  AppliedDiscount,
  CartItem,
  CartSource,
  DeliverySpeed,
  Money,
  SellerTerms,
} from '../storefront/types.ts';

// The client cart of the home page: a line per product with its unit price and the most a buyer
// can add. The server cart (guest cart API) replaces this state when checkout is wired; the
// limit then comes from the API's availability.

/** Default most units of one product in a cart line when stock is not low. */
export const LINE_LIMIT = 12;

export interface CartLine {
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly limit: number;
}

export type Cart = Readonly<Record<string, CartLine>>;

/** The most units of a product a line may hold: the units left when stock is low. */
export function lineLimit(lowStock: number | undefined): number {
  return lowStock === undefined ? LINE_LIMIT : Math.max(0, Math.min(lowStock, LINE_LIMIT));
}

export function addOne(cart: Cart, id: string, unitPrice: Money, limit: number): Cart {
  const line = cart[id];
  const quantity = Math.min(limit, (line?.quantity ?? 0) + 1);
  if (quantity === (line?.quantity ?? 0)) return cart;
  return { ...cart, [id]: { quantity, unitPrice, limit } };
}

export function removeOne(cart: Cart, id: string): Cart {
  const line = cart[id];
  if (!line) return cart;
  if (line.quantity <= 1) {
    return Object.fromEntries(Object.entries(cart).filter(([key]) => key !== id));
  }
  return { ...cart, [id]: { ...line, quantity: line.quantity - 1 } };
}

/** Item count and total. A cart holds one currency, the Market's; the first line's is used. */
export function summarise(cart: Cart): { count: number; total: Money | null } {
  const lines = Object.values(cart);
  if (lines.length === 0) return { count: 0, total: null };
  const currency = lines[0]!.unitPrice.currency;
  let count = 0;
  let amount = 0;
  for (const line of lines) {
    count += line.quantity;
    amount += line.quantity * line.unitPrice.amount;
  }
  return { count, total: { amount, currency } };
}

/** Removes a line whatever its quantity (the Remove link). */
export function removeLine(cart: Cart, id: string): Cart {
  if (!(id in cart)) return cart;
  return Object.fromEntries(Object.entries(cart).filter(([key]) => key !== id));
}

export interface CartGroupLine {
  readonly id: string;
  readonly item: CartItem;
  readonly quantity: number;
  readonly limit: number;
  readonly total: Money;
}

/** The delivery a buyer chose for one seller at checkout; Express carries the courier's quote. */
export type DeliveryChoice =
  { readonly speed: 'scheduled' } | { readonly speed: 'express'; readonly fee: Money };

/** One seller's part of the cart: its lines, subtotal and how far it is from its minimum. */
export interface CartGroup {
  readonly seller: SellerTerms;
  /** Scheduled unless Express was chosen at checkout. */
  readonly speed: DeliverySpeed;
  /** The seller's flat fee, or the Express quote when Express was chosen. */
  readonly deliveryFee: Money;
  readonly lines: readonly CartGroupLine[];
  readonly count: number;
  readonly subtotal: Money;
  /** What is still needed to reach the seller's minimum order; zero when reached or none. */
  readonly shortfall: Money;
}

export interface CartView {
  readonly groups: readonly CartGroup[];
  readonly count: number;
  readonly items: Money;
  /** Off the items only, never off delivery; zero without a code. */
  readonly discount: Money;
  readonly delivery: Money;
  readonly total: Money;
  /** The tax the total includes, from the source's preview (a placeholder, not a rule). */
  readonly includedTax: Money;
  /** Sellers below their minimum order: checkout is blocked while there is one. */
  readonly blocked: readonly CartGroup[];
}

/**
 * The cart by seller, in the order the sellers were first added, with each seller's delivery fee
 * and minimum order. Lines whose offer the source does not know are left out. Null when empty.
 * A discount comes off the items; minimum orders are checked on the items before it. `delivery`
 * holds the checkout's choices by seller id; a seller without one is delivered Scheduled.
 */
export function viewCart(
  cart: Cart,
  source: CartSource,
  discount: AppliedDiscount | null = null,
  delivery: Readonly<Record<string, DeliveryChoice>> = {},
): CartView | null {
  const bySeller = new Map<string, CartGroupLine[]>();
  for (const [id, line] of Object.entries(cart)) {
    const item = source.items[id];
    if (!item || !source.sellers[item.sellerId]) continue;
    const lines = bySeller.get(item.sellerId) ?? [];
    lines.push({
      id,
      item,
      quantity: line.quantity,
      limit: line.limit,
      total: { amount: line.quantity * item.price.amount, currency: item.price.currency },
    });
    bySeller.set(item.sellerId, lines);
  }
  if (bySeller.size === 0) return null;
  const currency = [...bySeller.values()][0]![0]!.total.currency;
  const groups = [...bySeller].map(([sellerId, lines]): CartGroup => {
    const seller = source.sellers[sellerId]!;
    const subtotal = lines.reduce((sum, l) => sum + l.total.amount, 0);
    const minimum = seller.minimumOrder?.amount ?? 0;
    const choice = delivery[sellerId];
    return {
      seller,
      speed: choice?.speed ?? 'scheduled',
      deliveryFee: choice?.speed === 'express' ? choice.fee : seller.deliveryFee,
      lines,
      count: lines.reduce((sum, l) => sum + l.quantity, 0),
      subtotal: { amount: subtotal, currency },
      shortfall: { amount: Math.max(0, minimum - subtotal), currency },
    };
  });
  const items = groups.reduce((sum, g) => sum + g.subtotal.amount, 0);
  const fees = groups.reduce((sum, g) => sum + g.deliveryFee.amount, 0);
  const off = discount ? Math.round((items * discount.percentOff) / 100) : 0;
  const { share, includesDelivery } = source.tax;
  // Placeholder: the discount's GST treatment is not settled; the preview shares the total.
  const taxed = items - off + (includesDelivery ? fees : 0);
  return {
    groups,
    count: groups.reduce((sum, g) => sum + g.count, 0),
    items: { amount: items, currency },
    discount: { amount: off, currency },
    delivery: { amount: fees, currency },
    total: { amount: items - off + fees, currency },
    includedTax: { amount: Math.round((taxed * share.numerator) / share.denominator), currency },
    blocked: groups.filter((g) => g.shortfall.amount > 0),
  };
}
