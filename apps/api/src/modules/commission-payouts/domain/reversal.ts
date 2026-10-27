// Refund reversals in the seller ledger (Phase 5 package 6a). Every amount comes from the ledger
// rows already stored for the seller order (sale, commission, shipping), never from a price or a
// rate: a refund of `units` out of `quantity` reverses the stored row proportionally. The
// reversal is cumulative, so any sequence of partial refunds adds up to exactly the original row:
//
//   reversed(u) = round_half_up(rowAmount × u / quantity)
//   posted      = reversed(unitsBefore + units) − reversed(unitsBefore)
//
// Pure integer arithmetic on bigint; no Market, currency or tax rule lives here. The rows keep the
// basis they were written in (a tax-inclusive line is reversed tax-inclusive, an exclusive one
// exclusive), because the proportion is taken from the row itself.

/** `round(numerator / denominator)`, half away from zero, for non-negative integers. */
const roundHalfUp = (numerator: bigint, denominator: bigint): bigint =>
  (numerator * 2n + denominator) / (denominator * 2n);

/**
 * The part of a stored amount reversed once `done` out of `total` is refunded (units of a line, or
 * minor units of the shipping charge). `done` runs from 0 (nothing: 0) to `total` (all: `amount`).
 */
export function reversedAmount(amount: bigint, done: bigint, total: bigint): bigint {
  if (amount < 0n || done < 0n || total <= 0n || done > total) {
    throw new RangeError('reversedAmount: amount >= 0 and 0 <= done <= total > 0');
  }
  return roundHalfUp(amount * done, total);
}

/** What one refund posts: the reversal at `after` less the reversal at `before`. */
export function reversalDelta(
  amount: bigint,
  before: bigint,
  after: bigint,
  total: bigint,
): bigint {
  if (after < before) throw new RangeError('reversalDelta: after must not be below before');
  return reversedAmount(amount, after, total) - reversedAmount(amount, before, total);
}

/** The stored rows of one order line that a refund of the line reverses. */
export interface LineRows {
  readonly sale: bigint;
  readonly commission: bigint;
  readonly commissionBase: bigint;
}

export interface LineReversal {
  readonly sale: bigint;
  readonly commission: bigint;
  /** The part of the commission base reversed (never below the commission reversed). */
  readonly base: bigint;
}

/**
 * The sale, the commission and the commission base reversed by refunding `units` of a line of
 * `lineQuantity` units after `unitsBefore` were refunded. The base never goes below the
 * commission reversed with it (the ledger refuses a commission above its base); that can only
 * differ from the plain proportion when a line is worth a few minor units per unit.
 */
export function reverseLine(
  rows: LineRows,
  unitsBefore: number,
  units: number,
  lineQuantity: number,
): LineReversal {
  const before = BigInt(unitsBefore);
  const after = BigInt(unitsBefore + units);
  const total = BigInt(lineQuantity);
  const commission = reversalDelta(rows.commission, before, after, total);
  const base = reversalDelta(rows.commissionBase, before, after, total);
  return {
    sale: reversalDelta(rows.sale, before, after, total),
    commission,
    base: base < commission ? commission : base,
  };
}

/**
 * The shipping row reversed by giving back the charge from `before` to `after` of `charge` (what
 * the customer paid for delivery, tax included; the row may exclude tax, the proportion keeps it
 * so that the whole charge reverses exactly the whole row).
 */
export function reverseShipping(
  shippingRow: bigint,
  before: bigint,
  after: bigint,
  charge: bigint,
): bigint {
  return reversalDelta(shippingRow, before, after, charge);
}
