import { Temporal, type Id } from '@mondapac/shared-kernel';
import type { MarketDay } from './facts';
import { daysOf, type DayRange, type ResolvedPeriod } from './period';

/** One seller's rollup row of one Market day, as the reader gives it (money in minor units). */
export interface SellerKpiDayRow {
  readonly marketDay: MarketDay;
  readonly ordersPaid: number;
  readonly goodsAmount: bigint;
  readonly goodsTax: bigint;
  readonly units: number;
  readonly ordersCancelled: number;
  readonly ordersShipped: number;
  readonly ordersShippedOnTime: number;
  /** How many refunds succeeded on the day (a positive count); the amounts below are negative, as stored. */
  readonly refunds: number;
  readonly refundGoodsAmount: bigint;
  readonly refundGoodsTax: bigint;
  readonly refundShippingAmount: bigint;
  readonly refundShippingTax: bigint;
  readonly refreshedAt: Temporal.Instant;
}

/** The current period's sales of one category, refunds taken off (as the rollup stores them). */
export interface SellerKpiCategoryRow {
  readonly categoryId: Id<'Category'>;
  readonly orders: number;
  readonly salesAmount: bigint;
  readonly salesTax: bigint;
  readonly salesUnits: number;
  /** At most 0. */
  readonly refundAmount: bigint;
}

export interface SellerKpiTotals {
  /** Goods of the paid orders in the period, with and without GST, shipping apart. */
  readonly salesInclTax: bigint;
  readonly salesExclTax: bigint;
  readonly orders: number;
  readonly units: number;
  /** Sales including GST per order; null with no order. */
  readonly averageOrderValue: bigint | null;
  /** The money refunded in the period (goods and shipping, with GST), as a positive amount. */
  readonly refundedInclTax: bigint;
  readonly refunds: number;
  /** Refunded goods over sales of the period, in basis points; null with no sales. */
  readonly refundRateBps: number | null;
  readonly ordersCancelled: number;
  readonly ordersShipped: number;
  /** Shipped on time over shipped, in basis points; null when nothing shipped. */
  readonly shippedOnTimeBps: number | null;
}

export interface SellerKpiDay {
  readonly day: MarketDay;
  readonly salesInclTax: bigint;
  readonly orders: number;
  readonly refundedInclTax: bigint;
}

export interface SellerKpiTopCategory {
  readonly categoryId: Id<'Category'>;
  /** Sales minus refunds, with GST. */
  readonly netSalesInclTax: bigint;
  readonly orders: number;
  readonly units: number;
}

export interface SellerKpis {
  readonly current: SellerKpiTotals;
  readonly previous: SellerKpiTotals;
  /** One entry per day of the current range, zero where the day has no row. */
  readonly series: readonly SellerKpiDay[];
  /** One entry per day of the previous range. */
  readonly previousSeries: readonly SellerKpiDay[];
  readonly topCategories: readonly SellerKpiTopCategory[];
  /** The latest refresh of any row read; null when the period has no row. */
  readonly refreshedAt: Temporal.Instant | null;
}

export const TOP_CATEGORIES = 5;

const bps = (part: bigint, whole: bigint): number | null =>
  whole <= 0n ? null : Number((part * 10000n) / whole);

const inRange = (day: MarketDay, range: DayRange): boolean => day >= range.from && day <= range.to;

/** The total of the rows of one range. */
export function totalsOf(rows: readonly SellerKpiDayRow[]): SellerKpiTotals {
  let sales = 0n;
  let tax = 0n;
  let orders = 0;
  let units = 0;
  let cancelled = 0;
  let shipped = 0;
  let onTime = 0;
  let refunds = 0;
  let refundedGoods = 0n;
  let refundedAll = 0n;
  for (const row of rows) {
    sales += row.goodsAmount;
    tax += row.goodsTax;
    orders += row.ordersPaid;
    units += row.units;
    cancelled += row.ordersCancelled;
    shipped += row.ordersShipped;
    onTime += row.ordersShippedOnTime;
    refunds += row.refunds;
    refundedGoods -= row.refundGoodsAmount;
    refundedAll -= row.refundGoodsAmount + row.refundShippingAmount;
  }
  return {
    salesInclTax: sales,
    salesExclTax: sales - tax,
    orders,
    units,
    averageOrderValue: orders === 0 ? null : sales / BigInt(orders),
    refundedInclTax: refundedAll,
    refunds,
    refundRateBps: bps(refundedGoods, sales),
    ordersCancelled: cancelled,
    ordersShipped: shipped,
    shippedOnTimeBps: bps(BigInt(onTime), BigInt(shipped)),
  };
}

function seriesOf(range: DayRange, rows: readonly SellerKpiDayRow[]): SellerKpiDay[] {
  const byDay = new Map(rows.map((row) => [row.marketDay, row]));
  return daysOf(range).map((day) => {
    const row = byDay.get(day);
    return {
      day,
      salesInclTax: row?.goodsAmount ?? 0n,
      orders: row?.ordersPaid ?? 0,
      refundedInclTax: row === undefined ? 0n : -(row.refundGoodsAmount + row.refundShippingAmount),
    };
  });
}

/**
 * The KPIs of one seller for a period, from its daily rows of both ranges (rows of other days are
 * ignored) and its category rows of the current range. Pure: the reader has already limited the
 * rows to the seller, the Market and the currency.
 */
export function buildSellerKpis(
  period: ResolvedPeriod,
  rows: readonly SellerKpiDayRow[],
  categories: readonly SellerKpiCategoryRow[],
): SellerKpis {
  const current = rows.filter((row) => inRange(row.marketDay, period.current));
  const previous = rows.filter((row) => inRange(row.marketDay, period.previous));
  const top = categories
    .map((row) => ({
      categoryId: row.categoryId,
      netSalesInclTax: row.salesAmount + row.refundAmount,
      orders: row.orders,
      units: row.salesUnits,
    }))
    .filter((row) => row.netSalesInclTax > 0n)
    .sort((a, b) =>
      a.netSalesInclTax === b.netSalesInclTax
        ? a.categoryId < b.categoryId
          ? -1
          : 1
        : a.netSalesInclTax > b.netSalesInclTax
          ? -1
          : 1,
    )
    .slice(0, TOP_CATEGORIES);
  const refreshed = [...current, ...previous].map((row) => row.refreshedAt);
  return {
    current: totalsOf(current),
    previous: totalsOf(previous),
    series: seriesOf(period.current, current),
    previousSeries: seriesOf(period.previous, previous),
    topCategories: top,
    refreshedAt:
      refreshed.length === 0
        ? null
        : refreshed.reduce((a, b) => (Temporal.Instant.compare(a, b) >= 0 ? a : b)),
  };
}
