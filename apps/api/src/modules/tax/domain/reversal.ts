// The tax a refund reverses (tax design 4.8, ADR-0007 decision 11), worked out from the values
// frozen on the order only: never from a current price, rate or strategy. Pure; no clock, no read.

/**
 * A line's frozen tax split into one share per unit: equal shares, and the remainder one minor
 * unit at a time to the earlier units (largest remainder with equal weights, ties to the earlier
 * unit; `UnitShareAllocator`). The share of the k-th refunded unit depends on the snapshot alone,
 * so partial refunds need no stored split and refunding every unit reverses exactly the line tax.
 */
export function unitShares(tax: bigint, quantity: number, from: number, units: number): bigint {
  const count = BigInt(quantity);
  const base = tax / count;
  const remainder = Number(tax % count);
  // Units at positions [from, from + units) that receive one extra minor unit.
  const extra = Math.max(0, Math.min(from + units, remainder) - from);
  return base * BigInt(units) + BigInt(extra);
}

/** `round(a / b)` with halves rounded up, for a ≥ 0 and b > 0. */
function divideHalfUp(a: bigint, b: bigint): bigint {
  return (a * 2n + b) / (b * 2n);
}

/**
 * The tax of an amount-based part of a charge (the flat shipping fee; `CumulativeAmountAllocator`):
 * `round(tax × after / gross) − round(tax × before / gross)`, where `before` and `after` are the
 * cumulative refunded gross of the charge before and after this refund. It telescopes, so
 * refunding the whole charge in any number of parts reverses exactly its tax.
 */
export function cumulativeShare(tax: bigint, gross: bigint, before: bigint, after: bigint): bigint {
  if (gross === 0n) return 0n;
  return divideHalfUp(tax * after, gross) - divideHalfUp(tax * before, gross);
}
