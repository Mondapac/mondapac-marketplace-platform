import { numberFormat } from '../shared/intl.ts';

const DIGITS = /^[0-9]{1,18}$/;

// ISO 4217 minor-unit digits for every currency that is not 2, the same table as the shared
// kernel's `minorUnitExponent` (packages/shared-kernel/src/money.ts). The panel does not read the
// browser's CLDR data: it differs from ISO for IQD, MGA and others.
const EXPONENT = new Map<string, number>([
  ...[
    'BIF',
    'CLP',
    'DJF',
    'GNF',
    'ISK',
    'JPY',
    'KMF',
    'KRW',
    'PYG',
    'RWF',
    'UGX',
    'UYI',
    'VND',
    'VUV',
    'XAF',
    'XOF',
    'XPF',
  ].map((code): [string, number] => [code, 0]),
  ...['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'].map((code): [string, number] => [code, 3]),
  ...['CLF', 'UYW'].map((code): [string, number] => [code, 4]),
]);

/**
 * The currency's minor-unit digits (AUD 2, JPY 0, KWD 3), or null for a code that is not a known
 * ISO 4217 currency. Callers fail closed on null; there is no guessed 2.
 */
export function decimalsOf(currency: string): number | null {
  const known = EXPONENT.get(currency);
  if (known !== undefined) return known;
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  try {
    return Intl.supportedValuesOf('currency').includes(currency) ? 2 : null;
  } catch {
    return null;
  }
}

/** Minor-unit digits as a plain decimal string in the currency's decimals ("2500" -> "25.00"). */
function toDecimal(minor: string, decimals: number): string {
  if (decimals === 0) return minor;
  const padded = minor.padStart(decimals + 1, '0');
  return `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`;
}

/**
 * A minor-unit string shown in its currency for the locale. The decimal string goes to Intl as
 * text, so no float is involved, and the digits shown are the ISO ones. A bad value or an unknown
 * currency shows as a dash.
 */
export function formatMinor(minor: string, currency: string, locale: string): string {
  const decimals = decimalsOf(currency);
  if (decimals === null || !DIGITS.test(minor)) return '-';
  try {
    return numberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(toDecimal(minor, decimals) as unknown as number);
  } catch {
    return '-';
  }
}

export type AmountParse =
  | { readonly ok: true; readonly minor: string }
  | { readonly ok: false; readonly problem: 'required' | 'format' | 'zero' | 'currency' };

/** What an admin typed, as minor units of the currency; at most the currency's decimals. */
export function parseAmount(text: string, currency: string): AmountParse {
  const decimals = decimalsOf(currency);
  if (decimals === null) return { ok: false, problem: 'currency' };
  const typed = text.trim();
  if (typed === '') return { ok: false, problem: 'required' };
  if (/^-\s*[0-9.]+$/.test(typed)) return { ok: false, problem: 'zero' };
  const pattern =
    decimals === 0 ? /^[0-9]{1,15}$/ : new RegExp(`^[0-9]{1,15}(\\.[0-9]{1,${decimals}})?$`);
  if (!pattern.test(typed)) return { ok: false, problem: 'format' };
  const [whole = '0', fraction = ''] = typed.split('.');
  const minor = BigInt(whole + fraction.padEnd(decimals, '0')).toString();
  return minor === '0' ? { ok: false, problem: 'zero' } : { ok: true, minor };
}

/** An example amount for the format message ("25.00", "25"). */
export function exampleAmount(currency: string): string {
  const decimals = decimalsOf(currency) ?? 2;
  return decimals === 0 ? '25' : `25.${'0'.repeat(decimals)}`;
}

const big = (value: string): bigint => (DIGITS.test(value) ? BigInt(value) : 0n);
export const isMore = (left: string, right: string): boolean => big(left) > big(right);
export const sumMinor = (left: string, right: string): string =>
  (big(left) + big(right)).toString();
