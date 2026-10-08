import type { PriceAmount } from './price-amount';
import type { PricingPolicy } from './pricing-policy';

export type JumpVerdict =
  { readonly kind: 'within' } | { readonly kind: 'held'; readonly direction: 'up' | 'down' };

/**
 * Whether a candidate regular price moves too far from the anchor (pricing design 4.2).
 * Threshold T = N/D, exact integer cross-multiplication, no floating point:
 * held `up` if `c*D > a*(D+N)`, held `down` if `c*D < a*(D-N)`. "More than T" is strict, so
 * exactly T is within. Only the directions the policy enables apply.
 */
export function measureJump(
  anchor: PriceAmount,
  candidate: PriceAmount,
  policy: PricingPolicy,
): JumpVerdict {
  const n = policy.thresholdNumerator;
  const d = policy.thresholdDenominator;
  const up = candidate.amount * d > anchor.amount * (d + n);
  const down = candidate.amount * d < anchor.amount * (d - n);
  if (up && policy.jumpDirections !== 'down') return { kind: 'held', direction: 'up' };
  if (down && policy.jumpDirections !== 'up') return { kind: 'held', direction: 'down' };
  return { kind: 'within' };
}
