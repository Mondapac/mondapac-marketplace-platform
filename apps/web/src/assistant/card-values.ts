// Field checks shared by every card parser of the assistant widget. A card comes from the network,
// so each field is checked on its own and a bad one drops the field or the card (R9).

/** Integer minor units plus an ISO 4217 code, as a card carries it. */
export interface CardMoney {
  readonly amount: number;
  readonly currency: string;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;

/** Ids on cards are UUIDs; anything else is dropped, so no id can bend a path (`..`, `/`). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const id = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value) ? value : null;

const CURRENCY = /^[A-Z]{3}$/;

/**
 * Money as the API sends it (the amount is a string of digits, minor units): a whole non-negative
 * amount in safe-integer range and an ISO 4217 code, else null. Nothing is assumed about the currency.
 */
export function moneyOf(value: unknown): CardMoney | null {
  if (!isRecord(value)) return null;
  const { amount, currency } = value;
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) return null;
  let minor: number;
  if (typeof amount === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(amount)) minor = Number(amount);
  else if (typeof amount === 'number' && Number.isInteger(amount) && amount >= 0) minor = amount;
  else return null;
  return Number.isSafeInteger(minor) ? { amount: minor, currency } : null;
}

/** A money field that is absent or null is none; present but malformed is `undefined`. */
export const optionalMoney = (value: unknown): CardMoney | null | undefined =>
  value === null || value === undefined ? null : (moneyOf(value) ?? undefined);

/** A whole number within bounds, else null. */
export const whole = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
