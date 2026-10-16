import { numberFormat } from '../shared/intl.ts';

/**
 * Digits after the decimal point in a currency (2 for AUD, 0 for JPY). They belong to the
 * currency (ISO 4217), not to a locale, so the root locale is used.
 */
export function exponentOf(currency: string): number {
  return numberFormat('und', { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits as number;
}

/** Minor units as a currency amount in the Market's locale, e.g. "1999" and AUD as "$19.99". */
export function formatMinor(amount: string, currency: string, locale: string): string {
  const value = Number(amount) / 10 ** exponentOf(currency);
  return numberFormat(locale, { style: 'currency', currency }).format(value);
}

/** The input text of an amount in major units, e.g. "1999" and AUD as "19.99". */
export function inputOf(amount: string, currency: string): string {
  const exponent = exponentOf(currency);
  if (exponent === 0) return amount;
  const padded = amount.padStart(exponent + 1, '0');
  return `${padded.slice(0, -exponent)}.${padded.slice(-exponent)}`;
}

/**
 * What the seller typed ("19.99", "20") as minor units, or null when it is not a positive amount
 * with at most the currency's decimals. Exact: no floating point.
 */
export function minorOf(text: string, currency: string): string | null {
  const exponent = exponentOf(currency);
  const match = /^(\d{1,13})(?:\.(\d+))?$/.exec(text.trim());
  if (match === null) return null;
  const fraction = match[2] ?? '';
  if (fraction.length > exponent) return null;
  const digits = `${match[1] as string}${fraction.padEnd(exponent, '0')}`.replace(/^0+(?=\d)/, '');
  return /^0+$/.test(digits) ? null : digits;
}
