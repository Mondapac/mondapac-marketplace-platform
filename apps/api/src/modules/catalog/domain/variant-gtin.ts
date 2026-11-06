/**
 * The GTIN of a variant (variants V4, plan decision 5): optional, GTIN-8, 12, 13 or 14, with the
 * GS1 check digit, kept as 14 digits (shorter codes are left-padded with zeros) so the same item
 * entered as GTIN-12 or GTIN-13 is one value. Pure functions, no I/O.
 */

/** The GS1 check digit of `digits` (the last digit is the check digit). */
export function gtinCheckDigitValid(digits: string): boolean {
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let index = 0; index < body.length; index += 1) {
    const weight = (body.length - index) % 2 === 1 ? 3 : 1;
    sum += Number(body[index]) * weight;
  }
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

export type GtinRefusal = 'invalid';

/**
 * The 14-digit form of a typed GTIN, or `invalid`. Spaces and hyphens around and inside the
 * digits are dropped; anything else that is not a digit, a length other than 8, 12, 13 or 14,
 * and a wrong check digit are refused. The value is never echoed.
 */
export function normalizeGtin(
  raw: string,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: GtinRefusal } {
  const digits = raw.trim().replace(/[\s-]/g, '');
  if (!/^[0-9]+$/.test(digits) || ![8, 12, 13, 14].includes(digits.length)) {
    return { ok: false, code: 'invalid' };
  }
  if (!gtinCheckDigitValid(digits)) return { ok: false, code: 'invalid' };
  return { ok: true, value: digits.padStart(14, '0') };
}
