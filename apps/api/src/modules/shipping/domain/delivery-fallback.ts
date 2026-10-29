import type { Money } from '@mondapac/shared-kernel';

// A booking the router gave to another fleet than the one the buyer was charged for (delivery
// models, package 5). The buyer has paid, so the price is never raised: the platform absorbs what
// the booked fleet costs above the quote the buyer was charged for, and an admin is alerted when
// that passes the Market's cap (a Market setting in minor units, AU default 1000 = A$10.00).
// A fleet that is cheaper costs the platform nothing extra and the buyer gets no refund.

export type FallbackAssessment =
  /** The booked fleet's price is known: `difference` is what the platform absorbs (never below 0). */
  | { readonly kind: 'known'; readonly difference: Money; readonly overCap: boolean }
  /** The booked fleet's price could not be read (or is in another currency): an admin looks. */
  | { readonly kind: 'cost-unknown'; readonly overCap: true };

/**
 * Compares what the booked fleet costs with the fleet quote the buyer was charged for. `capMinor`
 * is the Market's cap in minor units of the Market currency; a difference of exactly the cap is
 * still within it. The margin is the platform's own revenue and is not netted against the
 * difference.
 */
export function assessFallback(input: {
  readonly chargedQuote: Money;
  readonly bookedPrice: Money | null;
  readonly capMinor: number;
}): FallbackAssessment {
  const { chargedQuote, bookedPrice } = input;
  if (bookedPrice === null || bookedPrice.currency !== chargedQuote.currency) {
    return { kind: 'cost-unknown', overCap: true };
  }
  const raw = bookedPrice.amount - chargedQuote.amount;
  const amount = raw > 0n ? raw : 0n;
  return {
    kind: 'known',
    difference: { amount, currency: chargedQuote.currency },
    overCap: amount > BigInt(input.capMinor),
  };
}
