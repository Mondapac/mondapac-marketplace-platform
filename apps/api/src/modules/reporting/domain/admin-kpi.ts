import type { MarketDay } from './facts';
import { daysOf, delta, type DayRange, type Delta } from './period';

/**
 * The marketplace-wide numbers of one Market day, summed over every seller from
 * `reporting.daily_seller_sales` (dashboards upgrade phase 5). Money is minor units of the
 * Market's currency; refunds are NEGATIVE, as the rollup stores them (goods only: GMV counts goods
 * without shipping).
 */
export interface DayTotals {
  readonly day: MarketDay;
  readonly ordersPaid: number;
  readonly goodsAmount: bigint;
  readonly goodsTax: bigint;
  readonly ordersCancelled: number;
  readonly ordersShipped: number;
  readonly ordersShippedOnTime: number;
  readonly refunds: number;
  readonly refundGoodsAmount: bigint;
  readonly refundGoodsTax: bigint;
}

export const emptyDay = (day: MarketDay): DayTotals => ({
  day,
  ordersPaid: 0,
  goodsAmount: 0n,
  goodsTax: 0n,
  ordersCancelled: 0,
  ordersShipped: 0,
  ordersShippedOnTime: 0,
  refunds: 0,
  refundGoodsAmount: 0n,
  refundGoodsTax: 0n,
});

/** One row for every day of `range`, oldest first; a day with no fact is all zeros. */
export function fillDays(range: DayRange, rows: readonly DayTotals[]): DayTotals[] {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  return daysOf(range).map((day) => byDay.get(day) ?? emptyDay(day));
}

/** A ratio in basis points (1250 is 12.5%), rounded half up; null when the denominator is 0. */
export function ratioBp(numerator: number | bigint, denominator: number | bigint): number | null {
  const top = BigInt(numerator);
  const bottom = BigInt(denominator);
  if (bottom <= 0n) return null;
  return Number((top * 10000n * 2n + bottom) / (bottom * 2n));
}

/** `numerator / denominator` of minor units, rounded half up; null when the denominator is 0. */
export function averageMinor(total: bigint, count: number): bigint | null {
  if (count <= 0) return null;
  const divisor = BigInt(count);
  return (total * 2n + divisor) / (divisor * 2n);
}

export function sumDays(days: readonly DayTotals[]): Omit<DayTotals, 'day'> {
  return days.reduce<Omit<DayTotals, 'day'>>(
    (sum, row) => ({
      ordersPaid: sum.ordersPaid + row.ordersPaid,
      goodsAmount: sum.goodsAmount + row.goodsAmount,
      goodsTax: sum.goodsTax + row.goodsTax,
      ordersCancelled: sum.ordersCancelled + row.ordersCancelled,
      ordersShipped: sum.ordersShipped + row.ordersShipped,
      ordersShippedOnTime: sum.ordersShippedOnTime + row.ordersShippedOnTime,
      refunds: sum.refunds + row.refunds,
      refundGoodsAmount: sum.refundGoodsAmount + row.refundGoodsAmount,
      refundGoodsTax: sum.refundGoodsTax + row.refundGoodsTax,
    }),
    {
      ordersPaid: 0,
      goodsAmount: 0n,
      goodsTax: 0n,
      ordersCancelled: 0,
      ordersShipped: 0,
      ordersShippedOnTime: 0,
      refunds: 0,
      refundGoodsAmount: 0n,
      refundGoodsTax: 0n,
    },
  );
}

/** The operational numbers of a range (no money): they need only `ordering.order.view`. */
export interface OperationsKpis {
  readonly ordersPaid: number;
  readonly ordersCancelled: number;
  /** Cancelled ÷ paid, basis points; null with no paid order. */
  readonly cancelRateBp: number | null;
  readonly ordersShipped: number;
  /**
   * Shipped by the delivery promise ÷ shipped, basis points; null with no shipped order. Orders
   * still unshipped past their promise are not in the rollup yet (FE-067), so this can read
   * better than the truth.
   */
  readonly onTimeRateBp: number | null;
  readonly refunds: number;
}

export function operationsOf(days: readonly DayTotals[]): OperationsKpis {
  const sum = sumDays(days);
  return {
    ordersPaid: sum.ordersPaid,
    ordersCancelled: sum.ordersCancelled,
    cancelRateBp: ratioBp(sum.ordersCancelled, sum.ordersPaid),
    ordersShipped: sum.ordersShipped,
    onTimeRateBp: ratioBp(sum.ordersShippedOnTime, sum.ordersShipped),
    refunds: sum.refunds,
  };
}

/** The money numbers of a range (they need `commission-payouts.settlement.view`). */
export interface FinanceKpis {
  /** Goods of the paid seller orders, shipping apart. */
  readonly gmvWithTax: bigint;
  readonly gmvWithoutTax: bigint;
  /** Goods refunded on their refund day, a positive amount; refunds never lower GMV. */
  readonly refundedWithTax: bigint;
  /** Refunded ÷ GMV, basis points; null with no GMV. */
  readonly refundRateBp: number | null;
  /** GMV minus the refunds of the same range. */
  readonly netSalesWithTax: bigint;
  /** GMV ÷ paid seller orders (with tax); null with no paid order. */
  readonly averageOrderWithTax: bigint | null;
}

export function financeOf(days: readonly DayTotals[]): FinanceKpis {
  const sum = sumDays(days);
  const refunded = -sum.refundGoodsAmount;
  return {
    gmvWithTax: sum.goodsAmount,
    gmvWithoutTax: sum.goodsAmount - sum.goodsTax,
    refundedWithTax: refunded,
    refundRateBp: ratioBp(refunded, sum.goodsAmount),
    netSalesWithTax: sum.goodsAmount - refunded,
    averageOrderWithTax: averageMinor(sum.goodsAmount, sum.ordersPaid),
  };
}

/** Smallest previous count that gets a percentage; below it the change reads "n/a". */
export const MIN_COUNT_BASE = 5;
/** Smallest previous amount (minor units, 100.00 of the currency) that gets a percentage. */
export const MIN_MONEY_BASE = 10_000n;

const NA: Delta = { value: 0, direction: 'flat', state: 'na' };

/**
 * The change of a rate between two periods, in basis points of difference (the move from 2.0% to
 * 3.5% is +150), not a percentage of a percentage; `na` when either period has no rate or the previous period is too small to judge (the same minimum
 * bases as a count or an amount).
 */
export function rateDelta(
  current: number | null,
  previous: number | null,
  baseIsEnough: boolean,
): Delta {
  if (current === null || previous === null || !baseIsEnough) return NA;
  const change = current - previous;
  return {
    value: change,
    direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
    state: 'ok',
  };
}

export type KpiDeltas<K extends string> = Readonly<Record<K, Delta>>;

export function operationsDeltas(
  now: OperationsKpis,
  before: OperationsKpis,
): KpiDeltas<keyof OperationsKpis> {
  return {
    ordersPaid: delta(now.ordersPaid, before.ordersPaid, MIN_COUNT_BASE),
    ordersCancelled: delta(now.ordersCancelled, before.ordersCancelled, MIN_COUNT_BASE),
    cancelRateBp: rateDelta(
      now.cancelRateBp,
      before.cancelRateBp,
      before.ordersPaid >= MIN_COUNT_BASE,
    ),
    ordersShipped: delta(now.ordersShipped, before.ordersShipped, MIN_COUNT_BASE),
    onTimeRateBp: rateDelta(
      now.onTimeRateBp,
      before.onTimeRateBp,
      before.ordersShipped >= MIN_COUNT_BASE,
    ),
    refunds: delta(now.refunds, before.refunds, MIN_COUNT_BASE),
  };
}

export function financeDeltas(now: FinanceKpis, before: FinanceKpis): KpiDeltas<keyof FinanceKpis> {
  return {
    gmvWithTax: delta(now.gmvWithTax, before.gmvWithTax, MIN_MONEY_BASE),
    gmvWithoutTax: delta(now.gmvWithoutTax, before.gmvWithoutTax, MIN_MONEY_BASE),
    refundedWithTax: delta(now.refundedWithTax, before.refundedWithTax, MIN_MONEY_BASE),
    refundRateBp: rateDelta(
      now.refundRateBp,
      before.refundRateBp,
      before.gmvWithTax >= MIN_MONEY_BASE,
    ),
    netSalesWithTax: delta(now.netSalesWithTax, before.netSalesWithTax, MIN_MONEY_BASE),
    averageOrderWithTax:
      now.averageOrderWithTax === null || before.averageOrderWithTax === null
        ? NA
        : delta(now.averageOrderWithTax, before.averageOrderWithTax, MIN_MONEY_BASE),
  };
}
