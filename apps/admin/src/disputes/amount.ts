import { decimalsOf } from '../wallet/money.ts';

/**
 * Minor units as the plain decimal an admin types ("2500" -> "25.00", "2500" yen -> "2500"); an
 * unknown currency or a bad value gives an empty field rather than a guess.
 */
export function minorToField(minor: string, currency: string): string {
  const decimals = decimalsOf(currency);
  if (decimals === null || !/^[0-9]{1,18}$/.test(minor)) return '';
  if (decimals === 0) return BigInt(minor).toString();
  const padded = minor.padStart(decimals + 1, '0');
  return `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`;
}
