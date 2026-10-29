import type {
  AppliedDiscount,
  CartItem,
  CartSource,
  DeliveryMethod,
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

/**
 * Lowers a line to the units left when stock ran out at payment (0 removes it); the line's limit
 * follows, so the buyer cannot add back what is not there.
 */
export function limitLine(cart: Cart, id: string, left: number): Cart {
  const line = cart[id];
  if (!line) return cart;
  if (left <= 0) return removeLine(cart, id);
  return { ...cart, [id]: { ...line, quantity: Math.min(line.quantity, left), limit: left } };
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

/**
 * The delivery a buyer chose for one seller at checkout: the method, the stored quote it was
 * priced from (null for a pickup), the price with its GST apart, and a scheduled window (ISO
 * instants). The price is the server's quote shown back; the server charges its own stored quote.
 */
export interface DeliveryChoice {
  readonly method: DeliveryMethod;
  readonly quoteId: string | null;
  readonly total: Money;
  readonly tax: Money;
  readonly window: { readonly start: string; readonly end: string } | null;
}

/** One seller's part of the cart: its lines, subtotal and how far it is from its minimum. */
export interface CartGroup {
  readonly seller: SellerTerms;
  /** The delivery chosen at checkout; null until a method is chosen and priced. */
  readonly delivery: DeliveryChoice | null;
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
  /** The delivery chosen so far, GST included; zero while none is chosen. */
  readonly delivery: Money;
  /** True while a seller has no delivery chosen: the total is then without that delivery. */
  readonly deliveryPending: boolean;
  readonly total: Money;
  /**
   * The tax the total includes: the items' share from the source's preview (a placeholder, not a
   * rule) plus the GST of each chosen delivery as the server's quote states it.
   */
  readonly includedTax: Money;
  /** Sellers below their minimum order: checkout is blocked while there is one. */
  readonly blocked: readonly CartGroup[];
}

/**
 * The cart by seller, in the order the sellers were first added, with each seller's minimum order.
 * Lines whose offer the source does not know are left out. Null when empty. A discount comes off
 * the items; minimum orders are checked on the items before it. `delivery` holds the checkout's
 * choices by seller id; a seller without one has no delivery yet (it is priced at checkout).
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
      delivery: choice ?? null,
      lines,
      count: lines.reduce((sum, l) => sum + l.quantity, 0),
      subtotal: { amount: subtotal, currency },
      shortfall: { amount: Math.max(0, minimum - subtotal), currency },
    };
  });
  const items = groups.reduce((sum, g) => sum + g.subtotal.amount, 0);
  const fees = groups.reduce((sum, g) => sum + (g.delivery?.total.amount ?? 0), 0);
  const deliveryTax = groups.reduce((sum, g) => sum + (g.delivery?.tax.amount ?? 0), 0);
  const off = discount ? Math.round((items * discount.percentOff) / 100) : 0;
  const { share } = source.tax;
  // Placeholder: the discount's GST treatment is not settled; the preview shares the items.
  const taxed = items - off;
  return {
    groups,
    count: groups.reduce((sum, g) => sum + g.count, 0),
    items: { amount: items, currency },
    discount: { amount: off, currency },
    delivery: { amount: fees, currency },
    deliveryPending: groups.some((g) => g.delivery === null),
    total: { amount: items - off + fees, currency },
    includedTax: {
      amount: Math.round((taxed * share.numerator) / share.denominator) + deliveryTax,
      currency,
    },
    blocked: groups.filter((g) => g.shortfall.amount > 0),
  };
}
