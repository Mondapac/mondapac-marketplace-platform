/** Digits after the decimal point in a currency (2 for AUD, 0 for JPY). */
export function exponentOf(currency: string): number {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits as number;
}

/** Minor units as a currency amount, e.g. "995" and AUD as "$9.95". */
export function formatMinor(amount: string, currency: string): string {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(
    Number(amount) / 10 ** exponentOf(currency),
  );
}

/** The input text of an amount in major units, e.g. "995" and AUD as "9.95". */
export function inputOf(amount: string, currency: string): string {
  const exponent = exponentOf(currency);
  if (exponent === 0) return amount;
  const padded = amount.padStart(exponent + 1, '0');
  return `${padded.slice(0, -exponent)}.${padded.slice(-exponent)}`;
}

/**
 * What the admin typed ("9.95", "0") as minor units, or null when it is not an amount with at
 * most the currency's decimals. Zero is valid: a free-shipping seller. Exact: no floating point.
 */
export function minorOf(text: string, currency: string): number | null {
  const exponent = exponentOf(currency);
  const match = /^(\d{1,7})(?:\.(\d+))?$/.exec(text.trim());
  if (match === null) return null;
  const fraction = match[2] ?? '';
  if (fraction.length > exponent) return null;
  return Number(`${match[1] as string}${fraction.padEnd(exponent, '0')}`);
}
