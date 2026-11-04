/**
 * The card brands the Market takes at launch (owner decision): Visa and Mastercard. Stripe's
 * lowercase brand names. A wallet (Apple Pay, Google Pay) shows the brand of the card behind it.
 */
export const ACCEPTED_CARD_BRANDS: readonly string[] = Object.freeze(['visa', 'mastercard']);

/** The payment method types a ConfirmationToken may carry: a card, which covers the wallets. */
export const ACCEPTED_METHOD_TYPE = 'card';

/**
 * Card payment attempts one customer account may make in one window (10 minutes, the window of
 * the `checkout-payment` counter): each attempt reserves stock and calls Stripe, so the limit is
 * small. Not a Market setting.
 */
export const PAYMENT_ATTEMPTS_PER_WINDOW = 8;

export const isAcceptedCard = (methodType: string, brand: string | null): boolean =>
  methodType === ACCEPTED_METHOD_TYPE && brand !== null && ACCEPTED_CARD_BRANDS.includes(brand);

const CONFIRMATION_TOKEN = /^ctoken_[A-Za-z0-9_]{1,200}$/;

export const isConfirmationToken = (value: unknown): value is string =>
  typeof value === 'string' && CONFIRMATION_TOKEN.test(value);

const MINOR_UNITS = /^(0|[1-9][0-9]{0,14})$/;
const CURRENCY = /^[A-Z]{3}$/;

/**
 * The total the buyer saw, if the client sends it: `{ amount: "1999", currency: "AUD" }`. It is
 * only compared with the server's own total, never used as a price. Absent is fine.
 */
export function parseExpectedTotal(
  value: unknown,
):
  | { readonly ok: true; readonly total: { amount: bigint; currency: string } | null }
  | { readonly ok: false } {
  if (value === undefined || value === null) return { ok: true, total: null };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const { amount, currency, ...rest } = value as Record<string, unknown>;
  if (
    Object.keys(rest).length > 0 ||
    typeof amount !== 'string' ||
    !MINOR_UNITS.test(amount) ||
    typeof currency !== 'string' ||
    !CURRENCY.test(currency)
  ) {
    return { ok: false };
  }
  return { ok: true, total: { amount: BigInt(amount), currency } };
}
