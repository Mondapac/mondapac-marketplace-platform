// Number-with-unit values in the seller form (attributes A3). A saved measure is
// `{ value, unit }`: `value` is decimal text in the dimension's base unit (g, ml, mm, count) and
// `unit` is what the seller picked; the form shows and takes the number in that unit. The
// arithmetic is the shared kernel's (packages/shared-kernel/src/measure.ts), repeated here because
// a panel imports the kernel for types only: exact decimal text with BigInt, never a float.

/** How many base units one unit is: the same whole numbers as the kernel's table. */
const FACTOR: Readonly<Record<string, number>> = {
  g: 1,
  kg: 1000,
  ml: 1,
  l: 1000,
  mm: 1,
  cm: 10,
  m: 1000,
  count: 1,
};

const PLAIN = /^(0|[1-9]\d{0,11})(?:\.(\d{1,9}))?$/;

/** Decimal places the field may allow; the same ceiling as the kernel's MEASURE_DECIMALS_MAX. */
export const MEASURE_DECIMALS_MAX = 6;

function render(digits: bigint, scale: number): string {
  if (scale === 0) return digits.toString();
  const padded = digits.toString().padStart(scale + 1, '0');
  const fraction = padded.slice(padded.length - scale).replace(/0+$/, '');
  const whole = padded.slice(0, padded.length - scale);
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

/** Places in a plain decimal text, trailing zeros not counted; null when it is not plain. */
export function placesOf(text: string): number | null {
  const match = PLAIN.exec(text);
  return match === null ? null : (match[2] ?? '').replace(/0+$/, '').length;
}

/** What was typed, in `unit`, as base-unit text; null when it is not a plain number in that unit. */
export function toBase(amount: string, unit: string): string | null {
  const factor = FACTOR[unit];
  const match = PLAIN.exec(amount);
  if (factor === undefined || match === null) return null;
  const fraction = match[2] ?? '';
  return render(BigInt((match[1] ?? '0') + fraction) * BigInt(factor), fraction.length);
}

/** Base-unit text shown in `unit`, rounded half up to `decimals` places; null when invalid. */
export function fromBase(base: string, unit: string, decimals: number): string | null {
  const factor = FACTOR[unit];
  const match = PLAIN.exec(base);
  if (factor === undefined || match === null) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MEASURE_DECIMALS_MAX) return null;
  const fraction = match[2] ?? '';
  const denominator = 10n ** BigInt(fraction.length) * BigInt(factor);
  const numerator = BigInt((match[1] ?? '0') + fraction) * 10n ** BigInt(decimals);
  const quotient = numerator / denominator;
  const rounded = (numerator % denominator) * 2n >= denominator ? quotient + 1n : quotient;
  return render(rounded, decimals);
}
