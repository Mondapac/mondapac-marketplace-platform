import { fillDays, type DayTotals } from './admin-kpi';
import { daysOf, type DayRange } from './period';
import type { SellerKpiDayRow } from './seller-kpis';

// The rows of the dashboards' daily exports (dashboards v2, PR 5): one row per Market day of the
// range, a day with no fact all zeros, money in minor units of the Market's currency (named in
// its own column). Pure: no file format here (the shared list export writes the file).

/** One cell: text or a whole number. */
export type DailyExportCell = string | number;

/**
 * A money amount in minor units. A safe integer is written as a number, so a negative one (a net
 * of a refund-only day) is not mistaken for a formula and quoted; a larger one stays exact as text.
 */
export function moneyCell(amount: bigint): DailyExportCell {
  const value = Number(amount);
  return Number.isSafeInteger(value) ? value : amount.toString();
}

export const MARKETPLACE_DAILY_HEADER: readonly string[] = [
  'Day',
  'Currency',
  'GMV incl. tax (minor units)',
  'GMV excl. tax (minor units)',
  'Refunded goods incl. tax (minor units)',
  'Net sales incl. tax (minor units)',
  'Orders paid',
  'Orders cancelled',
  'Orders shipped',
  'Orders shipped on time',
  'Orders delivered',
  'Refunds',
];

/**
 * The marketplace's days: GMV is goods of paid seller orders on their paid day (shipping apart),
 * refunded goods count on their refund day as a positive amount, net sales is GMV less them.
 */
export function marketplaceDailyRows(
  range: DayRange,
  currency: string,
  rows: readonly DayTotals[],
): DailyExportCell[][] {
  return fillDays(range, rows).map((row) => {
    const refunded = -row.refundGoodsAmount;
    return [
      row.day,
      currency,
      moneyCell(row.goodsAmount),
      moneyCell(row.goodsAmount - row.goodsTax),
      moneyCell(refunded),
      moneyCell(row.goodsAmount - refunded),
      row.ordersPaid,
      row.ordersCancelled,
      row.ordersShipped,
      row.ordersShippedOnTime,
      row.ordersDelivered,
      row.refunds,
    ];
  });
}

export const SELLER_DAILY_HEADER: readonly string[] = [
  'Day',
  'Currency',
  'Sales incl. tax (minor units)',
  'Sales excl. tax (minor units)',
  'Orders',
  'Units',
  'Refunded incl. tax (minor units)',
  'Refunds',
  'Orders cancelled',
  'Orders shipped',
  'Orders shipped on time',
];

/**
 * One seller's days, the figures of its KPI cards: sales are goods of paid orders (shipping apart);
 * refunded is goods and shipping refunded on the day, positive.
 */
export function sellerDailyRows(
  range: DayRange,
  currency: string,
  rows: readonly SellerKpiDayRow[],
): DailyExportCell[][] {
  const byDay = new Map(rows.map((row) => [row.marketDay, row]));
  return daysOf(range).map((day) => {
    const row = byDay.get(day);
    if (row === undefined) return [day, currency, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    return [
      day,
      currency,
      moneyCell(row.goodsAmount),
      moneyCell(row.goodsAmount - row.goodsTax),
      row.ordersPaid,
      row.units,
      moneyCell(-(row.refundGoodsAmount + row.refundShippingAmount)),
      row.refunds,
      row.ordersCancelled,
      row.ordersShipped,
      row.ordersShippedOnTime,
    ];
  });
}
