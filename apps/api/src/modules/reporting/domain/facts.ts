import type { Id, Temporal } from '@mondapac/shared-kernel';

/**
 * A calendar day in the Market's configured time zone, `YYYY-MM-DD` (design section 6: never the
 * UTC day). Built only by {@link marketDayOf}.
 */
export type MarketDay = string & { readonly __brand: 'MarketDay' };

const MARKET_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The day of `at` in the IANA zone `zone`. */
export function marketDayOf(at: Temporal.Instant, zone: string): MarketDay {
  return at.toZonedDateTimeISO(zone).toPlainDate().toString() as MarketDay;
}

/** A stored day read back (the column is a `date`). Throws on anything else: a programmer error. */
export function parseMarketDay(text: string): MarketDay {
  if (!MARKET_DAY.test(text)) throw new TypeError(`not a market day: ${text}`);
  return text as MarketDay;
}

/**
 * An amount with its tax, in minor units of `currency`: `amount` includes the tax, so the amount
 * without tax is `amount - tax`. Built by {@link withTax} from a price that may or may not include
 * it, so every fact says the same thing whatever the Market's pricing convention.
 */
export interface TaxedAmount {
  readonly amount: bigint;
  readonly tax: bigint;
}

/**
 * A line priced with or without its tax (ordering freezes `taxInclusive`, the rate and the tax on
 * each line), as an amount that includes it. A line placed before tax was recorded has no tax: it
 * counts as tax 0, which reads as "without tax equals with tax" rather than as a guess.
 */
export function withTax(price: bigint, tax: bigint | null, taxInclusive: boolean): TaxedAmount {
  const knownTax = tax ?? 0n;
  if (price < 0n || knownTax < 0n) throw new RangeError('withTax: negative price or tax');
  if (taxInclusive) {
    if (knownTax > price) throw new RangeError('withTax: the tax is larger than the price');
    return { amount: price, tax: knownTax };
  }
  return { amount: price + knownTax, tax: knownTax };
}

/** The nil UUID: the category of goods whose category could not be read. */
export const UNKNOWN_CATEGORY = '00000000-0000-0000-0000-000000000000' as Id<'Category'>;

/** One seller order as reporting records it (table `reporting.seller_orders`). */
export interface SellerOrderFact {
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly orderId: Id<'Order'>;
  readonly sellerId: Id<'Seller'>;
  readonly currency: string;
  /** Goods after discounts, with tax; shipping apart. */
  readonly goods: TaxedAmount;
  readonly units: number;
  readonly shipping: TaxedAmount;
  readonly paidAt: Temporal.Instant | null;
  readonly cancelledAt: Temporal.Instant | null;
  readonly shippedAt: Temporal.Instant | null;
  /** Null until it ships or its delivery promise passes unshipped. */
  readonly shippedOnTime: boolean | null;
  readonly deliveredAt: Temporal.Instant | null;
}

/** The instants of a stored seller order, as {@link keepKnownInstants} compares them. */
export type SellerOrderInstants = Pick<
  SellerOrderFact,
  'paidAt' | 'cancelledAt' | 'shippedAt' | 'shippedOnTime' | 'deliveredAt'
>;

/**
 * A seller order's instants only ever go from unknown to known (paid, cancelled, shipped,
 * delivered; on time once it shipped or its promise passed). A fact read before a later one but
 * written after it would put an instant back to null (Hassan, PR 10b finding 1): an instant the
 * stored fact knows and the new one does not is kept.
 */
export function keepKnownInstants(
  fact: SellerOrderFact,
  stored: SellerOrderInstants | null,
): SellerOrderFact {
  if (stored === null) return fact;
  return {
    ...fact,
    paidAt: fact.paidAt ?? stored.paidAt,
    cancelledAt: fact.cancelledAt ?? stored.cancelledAt,
    shippedAt: fact.shippedAt ?? stored.shippedAt,
    shippedOnTime: fact.shippedOnTime ?? stored.shippedOnTime,
    deliveredAt: fact.deliveredAt ?? stored.deliveredAt,
  };
}

/** One succeeded refund (table `reporting.refunds`), with positive totals. */
export interface RefundFact {
  readonly refundId: Id<'Refund'>;
  readonly orderId: Id<'Order'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly currency: string;
  /** The whole refund, goods and shipping. */
  readonly total: TaxedAmount;
  readonly shipping: TaxedAmount;
  readonly refundedAt: Temporal.Instant;
}

/** Goods of one category in a sale or a refund, before the sign is applied. */
export interface CategoryGoods {
  readonly categoryId: Id<'Category'>;
  readonly goods: TaxedAmount;
  readonly units: number;
}

export type SalesEntryKind = 'sale' | 'refund';

/**
 * One row of `reporting.sales_entries`: a sale is positive, a refund negative, on the day of the
 * payment or of the refund.
 */
export interface SalesEntry {
  readonly kind: SalesEntryKind;
  /** The seller order of a sale, the refund of a refund. */
  readonly sourceId: string;
  readonly categoryId: Id<'Category'>;
  readonly orderId: Id<'Order'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly currency: string;
  readonly marketDay: MarketDay;
  readonly amount: bigint;
  readonly tax: bigint;
  readonly units: number;
}

/** Merges goods of the same category, so one source has one entry per category. */
function byCategory(goods: readonly CategoryGoods[]): CategoryGoods[] {
  const merged = new Map<string, { amount: bigint; tax: bigint; units: number }>();
  for (const part of goods) {
    const known = merged.get(part.categoryId) ?? { amount: 0n, tax: 0n, units: 0 };
    merged.set(part.categoryId, {
      amount: known.amount + part.goods.amount,
      tax: known.tax + part.goods.tax,
      units: known.units + part.units,
    });
  }
  return [...merged.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([categoryId, sum]) => ({
      categoryId: categoryId as Id<'Category'>,
      goods: { amount: sum.amount, tax: sum.tax },
      units: sum.units,
    }));
}

/**
 * The sale entries of a paid seller order: one per category, on the day it was paid. An unpaid
 * seller order has none (GMV counts paid orders only).
 */
export function saleEntries(
  order: SellerOrderFact,
  goods: readonly CategoryGoods[],
  zone: string,
): SalesEntry[] {
  if (order.paidAt === null) return [];
  const day = marketDayOf(order.paidAt, zone);
  return byCategory(goods).map((part) => ({
    kind: 'sale',
    sourceId: order.sellerOrderId,
    categoryId: part.categoryId,
    orderId: order.orderId,
    sellerOrderId: order.sellerOrderId,
    sellerId: order.sellerId,
    currency: order.currency,
    marketDay: day,
    amount: part.goods.amount,
    tax: part.goods.tax,
    units: part.units,
  }));
}

/**
 * The refund entries of a refund: its goods per category as negative amounts, on the day of the
 * refund, so the day of the order it refunds keeps its number.
 */
export function refundEntries(
  refund: RefundFact,
  goods: readonly CategoryGoods[],
  zone: string,
): SalesEntry[] {
  const day = marketDayOf(refund.refundedAt, zone);
  return byCategory(goods).map((part) => ({
    kind: 'refund',
    sourceId: refund.refundId,
    categoryId: part.categoryId,
    orderId: refund.orderId,
    sellerOrderId: refund.sellerOrderId,
    sellerId: refund.sellerId,
    currency: refund.currency,
    marketDay: day,
    amount: -part.goods.amount,
    tax: -part.goods.tax,
    units: -part.units,
  }));
}
