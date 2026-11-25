import { MIN_COUNT_BASE, MIN_MONEY_BASE, ratioBp } from './admin-kpi';
import { delta, type Delta } from './period';

/** The kinds of discount, as the dashboard names them (promotions' kinds, lower-case). */
export const DISCOUNT_KINDS = ['promotion', 'first-order', 'free-shipping'] as const;
export type DiscountKind = (typeof DISCOUNT_KINDS)[number];

/** Money of a discount in minor units: the whole and who funded it. */
export interface DiscountAmounts {
  readonly amount: bigint;
  readonly platformShare: bigint;
  readonly sellerShare: bigint;
}

/**
 * The discount totals of one range of Market days as promotions sums them (the orders whose
 * payment was confirmed in it): what still stands, per kind, and what those orders gave back since.
 */
export interface DiscountTotals {
  readonly kept: DiscountAmounts & { readonly orders: number };
  readonly byKind: readonly (DiscountAmounts & {
    readonly kind: DiscountKind;
    readonly uses: number;
  })[];
  readonly released: DiscountAmounts & { readonly orders: number };
}

/** Below this many uses of a kind, or orders given back, the figures are held back (null). */
export const MIN_DISCOUNT_DETAIL = MIN_COUNT_BASE;

/**
 * One kind's cost. A kind used by 1 to 4 redemptions is held back (every figure null) so one
 * order's discount is not read off the card; 0 uses shows zeros.
 */
export interface DiscountKindCost {
  readonly kind: DiscountKind;
  /** Redemptions (an order may use several promotions); null when held back. */
  readonly uses: number | null;
  readonly amount: bigint | null;
  readonly platformShare: bigint | null;
  /**
   * The kind's share of the whole discount, basis points; the kinds' shares add up to 10000
   * (largest remainder). Null when the whole is 0 or the kind is held back.
   */
  readonly shareBp: number | null;
}

/**
 * The discount cost of the period (dashboards v2, phase 2): the discounts of the orders paid in
 * its Market days that still stand, who funded them (`platformShare` is Mondapac's cost,
 * `sellerShare` the sellers'), by kind, the change against the period before, and what those
 * orders gave back since (refunded or cancelled after payment; already left out of `amount`).
 * Below {@link MIN_COUNT_BASE} discounted orders the numbers are held back (`not-enough-data`);
 * a kind with 1 to 4 uses and a `released` of 1 to 4 orders are held back alone.
 * Amounts include GST, as the prices they were taken from.
 */
export type DiscountCost =
  | { readonly status: 'not-enough-data'; readonly orders: number; readonly minimum: number }
  | {
      readonly status: 'available';
      /** Orders paid in the period with at least one discount that still stands. */
      readonly orders: number;
      readonly amount: bigint;
      readonly platformShare: bigint;
      readonly sellerShare: bigint;
      /** platformShare ÷ amount, basis points; null when amount is 0. */
      readonly platformShareBp: number | null;
      /** amount against the period before; `na` below 100.00 of the currency before. */
      readonly change: Delta;
      readonly previousAmount: bigint;
      /** Every kind, zeros included, in {@link DISCOUNT_KINDS} order. */
      readonly byKind: readonly DiscountKindCost[];
      /** Null when 1 to 4 orders gave a discount back (held back like a kind). */
      readonly released: { readonly orders: number; readonly amount: bigint } | null;
    };

/**
 * Shares of `total` in basis points that add up to exactly 10000: each floored, then the points
 * left go to the largest remainders (ties: the earlier entry). Null for all when `total` is 0.
 */
export function sharesBp(amounts: readonly bigint[], total: bigint): (number | null)[] {
  if (total <= 0n) return amounts.map(() => null);
  const scaled = amounts.map((amount) => amount * 10_000n);
  const floors = scaled.map((value) => value / total);
  let left = 10_000n - floors.reduce((sum, value) => sum + value, 0n);
  const order = scaled
    .map((value, index) => ({ index, remainder: value % total }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
  const shares = [...floors];
  for (const { index } of order) {
    if (left <= 0n) break;
    shares[index] = shares[index]! + 1n;
    left -= 1n;
  }
  return shares.map(Number);
}

const heldBack = (count: number): boolean => count > 0 && count < MIN_DISCOUNT_DETAIL;

function checked(totals: DiscountTotals): DiscountTotals {
  const amounts = [totals.kept, totals.released, ...totals.byKind];
  for (const row of amounts) {
    if (
      row.amount < 0n ||
      row.platformShare < 0n ||
      row.sellerShare < 0n ||
      row.platformShare + row.sellerShare !== row.amount
    ) {
      throw new RangeError('discount shares do not add up');
    }
  }
  if (totals.kept.orders < 0 || totals.released.orders < 0) {
    throw new RangeError('negative order count');
  }
  const sum = totals.byKind.reduce((total, row) => total + row.amount, 0n);
  if (sum !== totals.kept.amount) throw new RangeError('kinds do not add up to the total');
  return totals;
}

/** The discount cost of a period from its totals and those of the period before. */
export function discountCostOf(current: DiscountTotals, previous: DiscountTotals): DiscountCost {
  const now = checked(current);
  const before = checked(previous);
  const { orders, amount, platformShare, sellerShare } = now.kept;
  if (orders < MIN_COUNT_BASE) {
    return { status: 'not-enough-data', orders, minimum: MIN_COUNT_BASE };
  }
  const byKind = new Map(now.byKind.map((row) => [row.kind, row]));
  const rows = DISCOUNT_KINDS.map((kind) => {
    const row = byKind.get(kind);
    return {
      kind,
      uses: row?.uses ?? 0,
      amount: row?.amount ?? 0n,
      platformShare: row?.platformShare ?? 0n,
    };
  });
  const shares = sharesBp(
    rows.map((row) => row.amount),
    amount,
  );
  return {
    status: 'available',
    orders,
    amount,
    platformShare,
    sellerShare,
    platformShareBp: ratioBp(platformShare, amount),
    change: delta(amount, before.kept.amount, MIN_MONEY_BASE),
    previousAmount: before.kept.amount,
    byKind: rows.map((row, index) =>
      heldBack(row.uses)
        ? { kind: row.kind, uses: null, amount: null, platformShare: null, shareBp: null }
        : { ...row, shareBp: shares[index] ?? null },
    ),
    released: heldBack(now.released.orders)
      ? null
      : { orders: now.released.orders, amount: now.released.amount },
  };
}
