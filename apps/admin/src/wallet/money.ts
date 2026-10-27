import { numberFormat } from '../shared/intl.ts';

const DIGITS = /^[0-9]{1,18}$/;

/** The currency's own minor-unit digits (AUD 2, JPY 0, KWD 3); never a fixed 100. */
export function decimalsOf(currency: string): number {
  try {
    return (
      numberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ??
      2
    );
  } catch {
    return 2;
  }
}

/** Minor-unit digits as a plain decimal string in the currency's decimals ("2500" -> "25.00"). */
function toDecimal(minor: string, currency: string): string {
  const decimals = decimalsOf(currency);
  if (decimals === 0) return minor;
  const padded = minor.padStart(decimals + 1, '0');
  return `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`;
}

/**
 * A minor-unit string shown in its currency for the locale. The decimal string goes to Intl as
 * text, so no float is involved. A bad value or currency shows as a dash.
 */
export function formatMinor(minor: string, currency: string, locale: string): string {
  if (!DIGITS.test(minor)) return '-';
  try {
    return numberFormat(locale, { style: 'currency', currency }).format(
      toDecimal(minor, currency) as unknown as number,
    );
  } catch {
    return '-';
  }
}

export type AmountParse =
  | { readonly ok: true; readonly minor: string }
  | { readonly ok: false; readonly problem: 'required' | 'format' | 'zero' };

/** What an admin typed, as minor units of the currency; at most the currency's decimals. */
export function parseAmount(text: string, currency: string): AmountParse {
  const typed = text.trim();
  if (typed === '') return { ok: false, problem: 'required' };
  if (/^-/.test(typed) && /^-\s*[0-9.]+$/.test(typed)) return { ok: false, problem: 'zero' };
  const decimals = decimalsOf(currency);
  const pattern =
    decimals === 0 ? /^[0-9]{1,15}$/ : new RegExp(`^[0-9]{1,15}(\\.[0-9]{1,${decimals}})?$`);
  if (!pattern.test(typed)) return { ok: false, problem: 'format' };
  const [whole = '0', fraction = ''] = typed.split('.');
  const minor = BigInt(whole + fraction.padEnd(decimals, '0')).toString();
  return minor === '0' ? { ok: false, problem: 'zero' } : { ok: true, minor };
}

/** An example amount for the format message ("25.00", "25"). */
export function exampleAmount(currency: string): string {
  const decimals = decimalsOf(currency);
  return decimals === 0 ? '25' : `25.${'0'.repeat(decimals)}`;
}

const big = (value: string): bigint => (DIGITS.test(value) ? BigInt(value) : 0n);
export const isMore = (left: string, right: string): boolean => big(left) > big(right);
export const sumMinor = (left: string, right: string): string =>
  (big(left) + big(right)).toString();
