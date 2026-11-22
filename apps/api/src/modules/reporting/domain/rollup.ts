import type { Id } from '@mondapac/shared-kernel';
import type { MarketDay, SalesEntry } from './facts';

/** The key of a rollup: one Market day of one seller (the Market is the unit's). */
export interface SellerDay {
  readonly marketDay: MarketDay;
  readonly sellerId: Id<'Seller'>;
}

export const sellerDayKey = (key: SellerDay): string => `${key.marketDay}|${key.sellerId}`;

/** Distinct keys, in a stable order (day, then seller), so units lock rows in one order. */
export function distinctSellerDays(keys: readonly SellerDay[]): SellerDay[] {
  const seen = new Map<string, SellerDay>();
  for (const key of keys) seen.set(sellerDayKey(key), key);
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, key]) => key);
}

/** A seller order as the rollup of one day sees it: only the days that fall on that day matter. */
export interface DaySellerOrder {
  readonly sellerOrderId: string;
  readonly currency: string;
  readonly goodsAmount: bigint;
  readonly goodsTax: bigint;
  readonly units: number;
  readonly shippingAmount: bigint;
  readonly shippingTax: bigint;
  readonly paidOnDay: boolean;
  readonly cancelledOnDay: boolean;
  readonly shippedOnDay: boolean;
  readonly shippedOnTime: boolean | null;
  readonly deliveredOnDay: boolean;
}

/** A refund of the day, with its positive totals as stored. */
export interface DayRefund {
  readonly currency: string;
  readonly amount: bigint;
  readonly tax: bigint;
  readonly shippingAmount: bigint;
  readonly shippingTax: bigint;
}

/** Every fact of one seller on one Market day, as the store loads it. */
export interface SellerDayFacts {
  readonly sellerOrders: readonly DaySellerOrder[];
  readonly refunds: readonly DayRefund[];
  readonly entries: readonly SalesEntry[];
}

/** A row of `reporting.daily_seller_sales`, without its key and refresh time. */
export interface SellerDayTotals {
  readonly currency: string;
  readonly ordersPaid: number;
  readonly goodsAmount: bigint;
  readonly goodsTax: bigint;
  readonly units: number;
  readonly shippingAmount: bigint;
  readonly shippingTax: bigint;
  readonly ordersCancelled: number;
  readonly ordersShipped: number;
  readonly ordersShippedOnTime: number;
  readonly ordersDelivered: number;
  readonly refunds: number;
  /** Negative, goods and shipping apart (net GMV is `goodsAmount + refundGoodsAmount`). */
  readonly refundGoodsAmount: bigint;
  readonly refundGoodsTax: bigint;
  readonly refundShippingAmount: bigint;
  readonly refundShippingTax: bigint;
}

/** A row of `reporting.daily_category_sales`, without its key and refresh time. */
export interface CategoryDayTotals {
  readonly categoryId: Id<'Category'>;
  readonly currency: string;
  readonly orders: number;
  readonly salesAmount: bigint;
  readonly salesTax: bigint;
  readonly salesUnits: number;
  readonly refundAmount: bigint;
  readonly refundTax: bigint;
  readonly refundUnits: number;
}

export interface SellerDayRollup {
  /** One row per currency; empty when the day has no fact left (the rows are removed). */
  readonly seller: readonly SellerDayTotals[];
  readonly categories: readonly CategoryDayTotals[];
}

const emptySellerTotals = (currency: string): SellerDayTotals => ({
  currency,
  ordersPaid: 0,
  goodsAmount: 0n,
  goodsTax: 0n,
  units: 0,
  shippingAmount: 0n,
  shippingTax: 0n,
  ordersCancelled: 0,
  ordersShipped: 0,
  ordersShippedOnTime: 0,
  ordersDelivered: 0,
  refunds: 0,
  refundGoodsAmount: 0n,
  refundGoodsTax: 0n,
  refundShippingAmount: 0n,
  refundShippingTax: 0n,
});

/**
 * The rollup of one seller's day, from its facts. A seller order counts on each day one of its
 * instants falls on (paid, cancelled, shipped, delivered); its goods and shipping count on its
 * paid day only. A refund counts on its own day, as negative amounts (goods and shipping apart),
 * the same sign as the refund sales entries and the category rollup. A currency or a category with no fact gets no
 * row, so a fact that moved to another day leaves nothing behind.
 */
export function rollUpSellerDay(facts: SellerDayFacts): SellerDayRollup {
  const seller = new Map<string, SellerDayTotals>();
  const touch = (currency: string, change: (row: SellerDayTotals) => SellerDayTotals): void => {
    seller.set(currency, change(seller.get(currency) ?? emptySellerTotals(currency)));
  };
  for (const order of facts.sellerOrders) {
    if (order.paidOnDay) {
      touch(order.currency, (row) => ({
        ...row,
        ordersPaid: row.ordersPaid + 1,
        goodsAmount: row.goodsAmount + order.goodsAmount,
        goodsTax: row.goodsTax + order.goodsTax,
        units: row.units + order.units,
        shippingAmount: row.shippingAmount + order.shippingAmount,
        shippingTax: row.shippingTax + order.shippingTax,
      }));
    }
    if (order.cancelledOnDay) {
      touch(order.currency, (row) => ({ ...row, ordersCancelled: row.ordersCancelled + 1 }));
    }
    if (order.shippedOnDay) {
      touch(order.currency, (row) => ({
        ...row,
        ordersShipped: row.ordersShipped + 1,
        ordersShippedOnTime: row.ordersShippedOnTime + (order.shippedOnTime === true ? 1 : 0),
      }));
    }
    if (order.deliveredOnDay) {
      touch(order.currency, (row) => ({ ...row, ordersDelivered: row.ordersDelivered + 1 }));
    }
  }
  for (const refund of facts.refunds) {
    touch(refund.currency, (row) => ({
      ...row,
      refunds: row.refunds + 1,
      refundGoodsAmount: row.refundGoodsAmount - (refund.amount - refund.shippingAmount),
      refundGoodsTax: row.refundGoodsTax - (refund.tax - refund.shippingTax),
      refundShippingAmount: row.refundShippingAmount - refund.shippingAmount,
      refundShippingTax: row.refundShippingTax - refund.shippingTax,
    }));
  }

  const categories = new Map<
    string,
    CategoryDayTotals & { readonly sellerOrders: ReadonlySet<string> }
  >();
  for (const entry of facts.entries) {
    const key = `${entry.categoryId}|${entry.currency}`;
    const row = categories.get(key) ?? {
      categoryId: entry.categoryId,
      currency: entry.currency,
      orders: 0,
      salesAmount: 0n,
      salesTax: 0n,
      salesUnits: 0,
      refundAmount: 0n,
      refundTax: 0n,
      refundUnits: 0,
      sellerOrders: new Set<string>(),
    };
    categories.set(
      key,
      entry.kind === 'sale'
        ? {
            ...row,
            salesAmount: row.salesAmount + entry.amount,
            salesTax: row.salesTax + entry.tax,
            salesUnits: row.salesUnits + entry.units,
            sellerOrders: new Set([...row.sellerOrders, entry.sellerOrderId]),
          }
        : {
            ...row,
            refundAmount: row.refundAmount + entry.amount,
            refundTax: row.refundTax + entry.tax,
            refundUnits: row.refundUnits + entry.units,
          },
    );
  }

  const byKey = <T>(map: Map<string, T>): T[] =>
    [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, row]) => row);
  return {
    seller: byKey(seller),
    categories: byKey(categories).map(({ sellerOrders, ...row }) => ({
      ...row,
      orders: sellerOrders.size,
    })),
  };
}
