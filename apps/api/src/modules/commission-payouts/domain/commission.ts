import { err, ok } from '@mondapac/shared-kernel';
import type { Result, Temporal } from '@mondapac/shared-kernel';

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
 * tax-exclusive line is its own base. A tax-inclusive line has its own tax rate taken out
 * (`gross × 10000 / (10000 + taxBps)`, rounded half up). The rate is the one `tax` froze on the
 * line at placement (by the product's tax category, so a GST-free line has 0 and keeps its whole
 * amount as base); only a line placed before the rate was frozen falls back to the Market's
 * provisional rate (see {@link lineTaxBps}).
 */
export function commissionBase(lineAmount: bigint, taxInclusive: boolean, taxBps: number): bigint {
  if (!taxInclusive || taxBps === 0) return lineAmount;
  return roundHalfUp(lineAmount * BPS, BPS + BigInt(taxBps));
}

/**
 * The tax rate to take out of a line: the rate frozen on it at placement, or, only for a line
 * placed before rates were frozen (null or absent), the Market's provisional rate.
 */
export const lineTaxBps = (
  frozenTaxRateBps: number | null | undefined,
  provisionalTaxBps: number,
): number => frozenTaxRateBps ?? provisionalTaxBps;

/** One line's commission, worked out the one way the ledger posts it. */
export interface LineCommission {
  /** The amount the rate is applied to: the line without its tax. */
  readonly base: bigint;
  /** `base × rate`, rounded half up. */
  readonly commission: bigint;
  /**
   * What the seller is paid for the line: the line amount less the commission. On a
   * tax-inclusive line it still holds the line's tax, which the seller owes to the tax office.
   */
  readonly sellerReceives: bigint;
}

/**
 * The single rule for a line's commission and the seller's share of it (ledger, checkout cap and
 * promotions preview all use it): `amount` is what the seller is paid for the line before
 * commission (after the seller's share of any discount, never shipping), `taxBps` the line's own
 * tax rate ({@link lineTaxBps}).
 */
export function lineCommission(line: {
  readonly amount: bigint;
  readonly taxInclusive: boolean;
  readonly taxBps: number;
  readonly rateBps: number;
}): LineCommission {
  const base = commissionBase(line.amount, line.taxInclusive, line.taxBps);
  const commission = commissionOn(base, line.rateBps);
  return { base, commission, sellerReceives: line.amount - commission };
}

/** The commission on a base: `base × rate`, rounded half up; never more than the base. */
export function commissionOn(base: bigint, rateBps: number): bigint {
  return roundHalfUp(base * BigInt(rateBps), BPS);
}

/** The Market's lower commission for a seller's exclusive customer (customers phase 4b). */
export interface ExclusiveCommissionRule {
  /** The share of the rate in force taken off, in basis points of it (5000 = half). */
  readonly reductionBps: number;
  /** The lowest rate the reduction may reach, in basis points (300 = 3 %). */
  readonly floorBps: number;
  /** How long after the customer joined the seller the lower rate applies. */
  readonly months: number;
}

/**
 * The rate on a line of the seller whose exclusive customer the buyer is: the rate in force less
 * `reductionBps` of itself (rounded down, in the seller's favour), never below the floor and never
 * above the rate in force (a rate already under the floor stays as it is).
 */
export function exclusiveRateBps(rateBps: number, rule: ExclusiveCommissionRule): number {
  const reduced = Math.floor((rateBps * (10_000 - rule.reductionBps)) / 10_000);
  return Math.min(rateBps, Math.max(rule.floorBps, reduced));
}

/** Whether the lower rate still applies at `now` to a customer who joined at `since` (UTC months). */
export function exclusiveWindowOpen(
  since: Temporal.Instant,
  now: Temporal.Instant,
  rule: ExclusiveCommissionRule,
): boolean {
  const end = since.toZonedDateTimeISO('UTC').add({ months: rule.months }).toInstant();
  return now.epochMilliseconds < end.epochMilliseconds;
}
