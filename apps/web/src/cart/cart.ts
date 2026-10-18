import type { Money } from '../storefront/types.ts';

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
