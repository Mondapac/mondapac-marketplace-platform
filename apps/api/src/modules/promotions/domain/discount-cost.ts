import { REDEMPTION_KINDS, type RedemptionKind, type RedemptionStatus } from './redemption';

/** The kinds of discount the cost is split by (an order's head row is never one of them). */
export const DISCOUNT_COST_KINDS = ['PROMOTION', 'FIRST_ORDER', 'FREE_SHIPPING'] as const;
export type DiscountCostKind = (typeof DISCOUNT_COST_KINDS)[number];

/** Money in minor units of the asked currency: the whole discount and who funded it. */
export interface DiscountCostAmounts {
  readonly amount: bigint;
  readonly platformShare: bigint;
  readonly sellerShare: bigint;
}

/** One kind's discounts that still stand: how many redemptions (uses), and their cost. */
export interface DiscountCostByKind extends DiscountCostAmounts {
  readonly kind: DiscountCostKind;
  readonly uses: number;
}

/**
 * The discounts of the orders whose payment was confirmed in a window, in one currency
 * (dashboards v2, phase 2: the admin's discount cost). Totals only: no order, customer, code or
 * promotion leaves the module.
 * - `kept`: what still stands (CONFIRMED), with `orders` (the orders it discounted) and per kind;
 * - `released`: what the same window's orders gave back since (refunded or cancelled after
 *   payment), never subtracted twice: `kept` already leaves it out.
 */
export interface DiscountCostTotals {
  readonly kept: DiscountCostAmounts & { readonly orders: number };
  readonly byKind: readonly DiscountCostByKind[];
  readonly released: DiscountCostAmounts & { readonly orders: number };
}

/** One group of redemptions confirmed in a window, as the store sums them (kind and status). */
export interface DiscountCostGroup {
  readonly kind: RedemptionKind;
  readonly status: RedemptionStatus;
  readonly rows: number;
  readonly amount: bigint;
  readonly platformShare: bigint;
  readonly sellerShare: bigint;
}

const ZERO: DiscountCostAmounts = { amount: 0n, platformShare: 0n, sellerShare: 0n };

const plus = (a: DiscountCostAmounts, b: DiscountCostAmounts): DiscountCostAmounts => ({
  amount: a.amount + b.amount,
  platformShare: a.platformShare + b.platformShare,
  sellerShare: a.sellerShare + b.sellerShare,
});

const isCostKind = (kind: RedemptionKind): kind is DiscountCostKind =>
  (DISCOUNT_COST_KINDS as readonly string[]).includes(kind);

/**
 * Folds the groups of the redemptions confirmed in a window into the discount cost. A row confirmed
 * in the window is CONFIRMED (it stands) or RELEASED (its order was refunded or cancelled after the
 * payment); a RESERVED row has no confirmation, so the store never hands one. The orders are
 * counted by their head rows (kind ORDER, amount 0, one per redeemed order), so an order with three
 * discounts counts once. Every kind is listed, zeros included, in {@link DISCOUNT_COST_KINDS} order.
 */
export function discountCostOf(groups: readonly DiscountCostGroup[]): DiscountCostTotals {
  let kept = ZERO;
  let released = ZERO;
  let keptOrders = 0;
  let releasedOrders = 0;
  const byKind = new Map<DiscountCostKind, DiscountCostAmounts & { uses: number }>(
    DISCOUNT_COST_KINDS.map((kind) => [kind, { ...ZERO, uses: 0 }]),
  );
  for (const group of groups) {
    if (!(REDEMPTION_KINDS as readonly string[]).includes(group.kind)) {
      throw new RangeError(`unknown redemption kind ${group.kind}`);
    }
    if (group.status === 'RESERVED') {
      throw new RangeError('a reserved redemption has no confirmation');
    }
    const stands = group.status === 'CONFIRMED';
    if (!isCostKind(group.kind)) {
      if (stands) keptOrders += group.rows;
      else releasedOrders += group.rows;
      continue;
    }
    if (stands) {
      kept = plus(kept, group);
      const row = byKind.get(group.kind)!;
      byKind.set(group.kind, { ...plus(row, group), uses: row.uses + group.rows });
    } else {
      released = plus(released, group);
    }
  }
  return {
    kept: { ...kept, orders: keptOrders },
    byKind: DISCOUNT_COST_KINDS.map((kind) => ({ kind, ...byKind.get(kind)! })),
    released: { ...released, orders: releasedOrders },
  };
}
