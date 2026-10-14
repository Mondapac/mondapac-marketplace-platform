import { money } from '@mondapac/shared-kernel';
import type { Money } from '@mondapac/shared-kernel';

// The minimum order of one seller group (cart design 6.4; CRT-05). Pure: the caller passes what
// `sellers` said and the buyable lines of the group, and gets the state back. No facade, no
// Market, no default: an unknown minimum is never "no minimum".

/** What `sellers` said about a seller's minimum order (design 6.4, "none" and "absent" differ). */
export type SellerMinimum =
  /** The explicit none: any amount is enough. */
  | { readonly kind: 'none' }
  | { readonly kind: 'minimum'; readonly minimum: Money }
  /** Absent from the answer, or `sellers` failed: the cart cannot tell. */
  | { readonly kind: 'unknown' };

/** A buyable line of the group, as the evaluator needs it. */
export interface BuyableLine {
  readonly unitPrice: Money;
  readonly quantity: number;
  readonly taxInclusive: boolean | null;
}

/**
 * - `not-applicable`: the group has no buyable line, so there is nothing to hold to a minimum.
 * - `none`: the seller set no minimum (explicit).
 * - `met`: the subtotal of the buyable lines reaches the minimum.
 * - `below-minimum`: it does not; checkout is blocked for this seller only.
 * - `check-unavailable`: the minimum or the subtotal cannot be trusted (design 6.4 fail closed).
 */
export type MinimumOrderState =
  'not-applicable' | 'none' | 'met' | 'below-minimum' | 'check-unavailable';

export interface MinimumOrderEvaluation {
  readonly state: MinimumOrderState;
  /** The seller's minimum when known and public (`met` and `below-minimum`), else null. */
  readonly minimum: Money | null;
  /** Sum of the buyable lines; null when none, or when currencies mix. */
  readonly subtotal: Money | null;
}

const UNKNOWN: MinimumOrderEvaluation = {
  state: 'check-unavailable',
  minimum: null,
  subtotal: null,
};

/**
 * `CartEvaluator` for one seller group (design 6.4). The subtotal is the sum of the effective
 * unit prices times quantity of the buyable lines, in the Market's display convention, without
 * shipping and with no tax computed here. Order of the checks, all fail closed:
 * 1. no buyable line: `not-applicable`;
 * 2. the lines mix currencies or tax-inclusive flags (a sum would be meaningless): `check-unavailable`;
 * 3. the seller's minimum is unknown: `check-unavailable`; explicit none: `none`;
 * 4. the minimum is in another currency than the lines: `check-unavailable`;
 * 5. subtotal below the minimum: `below-minimum`; otherwise `met`.
 */
export function evaluateMinimumOrder(
  lines: readonly BuyableLine[],
  sellerMinimum: SellerMinimum | undefined,
): MinimumOrderEvaluation {
  if (lines.length === 0) return { state: 'not-applicable', minimum: null, subtotal: null };
  const currency = lines[0]!.unitPrice.currency;
  const mixedCurrency = lines.some((line) => line.unitPrice.currency !== currency);
  const mixedTax = lines.some((line) => line.taxInclusive !== lines[0]!.taxInclusive);
  if (mixedCurrency || mixedTax || lines[0]!.taxInclusive === null) return UNKNOWN;
  const subtotal = money(
    lines.reduce((sum, line) => sum + line.unitPrice.amount * BigInt(line.quantity), 0n),
    currency,
  );
  if (sellerMinimum === undefined || sellerMinimum.kind === 'unknown') {
    return { state: 'check-unavailable', minimum: null, subtotal };
  }
  if (sellerMinimum.kind === 'none') return { state: 'none', minimum: null, subtotal };
  const { minimum } = sellerMinimum;
  if (minimum.currency !== currency || minimum.amount <= 0n) {
    return { state: 'check-unavailable', minimum: null, subtotal };
  }
  return {
    state: subtotal.amount < minimum.amount ? 'below-minimum' : 'met',
    minimum,
    subtotal,
  };
}
