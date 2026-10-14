import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';

// Commission (Phase 5 package 5, COM-01/02/04/05, simplified for speed mode). A rate is a whole
// number of basis points (1500 = 15 %). The Market rate comes from Market config; an admin may
// set a separate rate per seller. ordering freezes the rate on each order line when the order is
// placed, so a later change never touches an earlier order.

/** The highest rate any seller may carry: 30 % (commission-payouts data design 3.2). */
export const MAX_RATE_BPS = 3000;

const BPS = 10_000n;

export type RateInvalid = { readonly code: 'validation.failed'; readonly path: 'rateBps' };

/** A rate from the wire: a whole number of basis points from 0 to {@link MAX_RATE_BPS}. */
export function parseRateBps(value: unknown): Result<number, RateInvalid> {
  return isRateBps(value) ? ok(value) : err({ code: 'validation.failed', path: 'rateBps' });
}

export const isRateBps = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_RATE_BPS;

/** `round(numerator / denominator)`, half away from zero, for non-negative integers. */
const roundHalfUp = (numerator: bigint, denominator: bigint): bigint =>
  (numerator * 2n + denominator) / (denominator * 2n);

/**
 * The commission base of one order line: the line amount after discounts, without GST (Q7). A
 * tax-exclusive line is its own base. A tax-inclusive line has the Market's provisional tax rate
 * taken out (`gross × 10000 / (10000 + taxBps)`, rounded half up) until the tax module (package 9)
 * gives the exact tax of each line.
 */
export function commissionBase(
  lineAmount: bigint,
  taxInclusive: boolean,
  provisionalTaxBps: number,
): bigint {
  if (!taxInclusive || provisionalTaxBps === 0) return lineAmount;
  return roundHalfUp(lineAmount * BPS, BPS + BigInt(provisionalTaxBps));
}

/** The commission on a base: `base × rate`, rounded half up; never more than the base. */
export function commissionOn(base: bigint, rateBps: number): bigint {
  return roundHalfUp(base * BigInt(rateBps), BPS);
}
