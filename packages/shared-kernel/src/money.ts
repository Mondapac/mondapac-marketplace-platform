import { err, ok } from './result';
import type { Result } from './result';

/**
 * Money (ADR-0007 decision 1): an integer amount of minor units and an ISO 4217 currency. No
 * floating point anywhere; the minor-unit exponent comes from the currency (JPY 0, AUD 2,
 * KWD 3), never an assumed 2. Arithmetic across currencies throws: there is no conversion in
 * the kernel. Values are immutable, so `===` on `amount` and `currency` is equality.
 */
export interface Money {
  readonly amount: bigint;
  readonly currency: string;
}

/** A programmer error: a malformed currency, a cross-currency operation, a bad ratio or weight. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Why `parseMoney` refused its input. Never holds the value. */
export type MoneyParseError =
  { readonly code: 'money.invalid-amount' } | { readonly code: 'money.invalid-currency' };

/** How a ratio that does not divide evenly is rounded. Always stated by the caller or `half-up`. */
export type RoundingMode = 'half-up' | 'half-even' | 'down' | 'up';

const CURRENCY_SHAPE = /^[A-Z]{3}$/;
const exponents = new Map<string, number>();

/**
 * The number of minor-unit digits of a currency, from the platform's ISO 4217 data. Throws
 * `MoneyError` for a code that is not a well-formed, known currency.
 */
export function minorUnitExponent(currency: string): number {
  const known = exponents.get(currency);
  if (known !== undefined) return known;
  if (typeof currency !== 'string' || !CURRENCY_SHAPE.test(currency)) {
    throw new MoneyError('currency must be an upper-case ISO 4217 code');
  }
  let digits: number | undefined;
  try {
    digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits;
  } catch {
    throw new MoneyError('currency must be an upper-case ISO 4217 code');
  }
  if (digits === undefined) throw new MoneyError('currency must be an upper-case ISO 4217 code');
  exponents.set(currency, digits);
  return digits;
}

/** Builds a Money from values the code already trusts. Throws `MoneyError` on a bad currency. */
export function money(amount: bigint, currency: string): Money {
  minorUnitExponent(currency);
  return { amount, currency };
}

/** Builds a Money from untrusted input: the amount must be a bigint, the currency well formed. */
export function parseMoney(amount: unknown, currency: unknown): Result<Money, MoneyParseError> {
  if (typeof currency !== 'string' || !CURRENCY_SHAPE.test(currency)) {
    return err({ code: 'money.invalid-currency' });
  }
  try {
    minorUnitExponent(currency);
  } catch {
    return err({ code: 'money.invalid-currency' });
  }
  if (typeof amount !== 'bigint') return err({ code: 'money.invalid-amount' });
  return ok({ amount, currency });
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError('money in different currencies cannot be combined');
  }
}

export function addMoney(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { amount: a.amount - b.amount, currency: a.currency };
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  if (a.amount === b.amount) return 0;
  return a.amount < b.amount ? -1 : 1;
}

/** `numerator / denominator` of the quotient `value / divisor`, rounded as `mode` says. */
function divideRounded(value: bigint, divisor: bigint, mode: RoundingMode): bigint {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const quotient = magnitude / divisor;
  const remainder = magnitude % divisor;
  let rounded = quotient;
  if (remainder !== 0n) {
    const twice = remainder * 2n;
    switch (mode) {
      case 'down':
        break;
      case 'up':
        rounded = quotient + 1n;
        break;
      case 'half-up':
        if (twice >= divisor) rounded = quotient + 1n;
        break;
      case 'half-even':
        if (twice > divisor || (twice === divisor && quotient % 2n === 1n)) rounded = quotient + 1n;
        break;
    }
  }
  return negative ? -rounded : rounded;
}

/**
 * `money x numerator / denominator` with the rounding stated (default half-up, away from zero
 * for a negative amount; ADR-0007 decision 2). A rate is an exact ratio of integers, never a
 * float; `down` and `up` are toward and away from zero.
 */
export function scaleMoney(
  value: Money,
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode = 'half-up',
): Money {
  if (denominator <= 0n) throw new MoneyError('denominator must be positive');
  if (numerator < 0n) throw new MoneyError('numerator must not be negative');
  return {
    amount: divideRounded(value.amount * numerator, denominator, mode),
    currency: value.currency,
  };
}

/**
 * Splits `whole` by `weights` with largest-remainder allocation (ADR-0007 decision 1), so the
 * parts always sum exactly to the whole. Leftover minor units go to the largest remainders, a
 * tie to the earlier part. Weights are non-negative and not all zero.
 */
export function allocateMoney(whole: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0) throw new MoneyError('at least one weight is required');
  if (weights.some((weight) => weight < 0n)) throw new MoneyError('weights must not be negative');
  const total = weights.reduce((sum, weight) => sum + weight, 0n);
  if (total === 0n) throw new MoneyError('weights must not all be zero');

  const negative = whole.amount < 0n;
  const magnitude = negative ? -whole.amount : whole.amount;
  const shares = weights.map((weight) => (magnitude * weight) / total);
  const remainders = weights.map((weight, index) => ({
    index,
    remainder: (magnitude * weight) % total,
  }));
  let left = magnitude - shares.reduce((sum, share) => sum + share, 0n);
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const { index } of remainders) {
    if (left === 0n) break;
    shares[index] = (shares[index] ?? 0n) + 1n;
    left -= 1n;
  }
  return shares.map((share) => ({
    amount: negative ? -share : share,
    currency: whole.currency,
  }));
}
