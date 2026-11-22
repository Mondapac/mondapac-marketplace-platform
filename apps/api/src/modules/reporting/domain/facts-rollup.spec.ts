import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  marketDayOf,
  refundEntries,
  saleEntries,
  UNKNOWN_CATEGORY,
  withTax,
  type MarketDay,
  type RefundFact,
  type SellerOrderFact,
} from './facts';
import { distinctSellerDays, rollUpSellerDay, type DaySellerOrder } from './rollup';

const id = <T extends string>(text: string) => text as Id<T>;
const SELLER = id<'Seller'>('0190f000-0000-7000-8000-000000000001');
const ORDER = id<'Order'>('0190f000-0000-7000-8000-0000000000a1');
const SELLER_ORDER = id<'SellerOrder'>('0190f000-0000-7000-8000-0000000000b1');
const REFUND = id<'Refund'>('0190f000-0000-7000-8000-0000000000c1');
const FOOD = id<'Category'>('0190f000-0000-7000-8000-0000000000d1');
const DRINK = id<'Category'>('0190f000-0000-7000-8000-0000000000d2');

// Two Markets of the fixtures: AU in Brisbane (UTC+10, no daylight saving) with AUD, and the
// synthetic Market in Tokyo (UTC+9) with a currency of exponent 0.
const MARKETS = [
  { name: 'AU', zone: 'Australia/Brisbane', currency: 'AUD' },
  { name: 'ZZ', zone: 'Asia/Tokyo', currency: 'JPY' },
] as const;

describe('withTax', () => {
  it('keeps a price that includes its tax and adds the tax to one that does not', () => {
    expect(withTax(1100n, 100n, true)).toEqual({ amount: 1100n, tax: 100n });
    expect(withTax(1000n, 100n, false)).toEqual({ amount: 1100n, tax: 100n });
  });

  it('counts a line placed before tax was recorded as tax 0', () => {
    expect(withTax(500n, null, true)).toEqual({ amount: 500n, tax: 0n });
  });

  it('refuses a negative amount or a tax larger than an inclusive price', () => {
    expect(() => withTax(-1n, 0n, true)).toThrow(RangeError);
    expect(() => withTax(10n, 11n, true)).toThrow(RangeError);
  });
});

describe.each(MARKETS)('reporting facts in market $name', ({ zone, currency }) => {
  // 23:30 UTC on 21 Nov is 22 Nov in both zones: the day is never the UTC day.
  const lateUtc = Temporal.Instant.from('2026-11-21T23:30:00Z');
  const order = (overrides: Partial<SellerOrderFact> = {}): SellerOrderFact => ({
    sellerOrderId: SELLER_ORDER,
    orderId: ORDER,
    sellerId: SELLER,
    currency,
    goods: { amount: 3300n, tax: 300n },
    units: 3,
    shipping: { amount: 990n, tax: 90n },
    paidAt: lateUtc,
    cancelledAt: null,
    shippedAt: null,
    shippedOnTime: null,
    deliveredAt: null,
    ...overrides,
  });

  it('counts the day in the Market zone, not in UTC', () => {
    expect(marketDayOf(lateUtc, zone)).toBe('2026-11-22');
  });

  it('writes one positive sale entry per category on the paid day, merging repeats', () => {
    const entries = saleEntries(
      order(),
      [
        { categoryId: FOOD, goods: { amount: 1100n, tax: 100n }, units: 1 },
        { categoryId: DRINK, goods: { amount: 1100n, tax: 100n }, units: 1 },
        { categoryId: FOOD, goods: { amount: 1100n, tax: 100n }, units: 1 },
      ],
      zone,
    );
    expect(
      entries.map((entry) => [entry.categoryId, entry.amount, entry.tax, entry.units]),
    ).toEqual(
      [
        [FOOD, 2200n, 200n, 2],
        [DRINK, 1100n, 100n, 1],
      ].sort(([a], [b]) => ((a as string) < (b as string) ? -1 : 1)),
    );
    expect(new Set(entries.map((entry) => entry.marketDay))).toEqual(new Set(['2026-11-22']));
    expect(entries.every((entry) => entry.kind === 'sale' && entry.currency === currency)).toBe(
      true,
    );
  });

  it('writes no sale entry for an unpaid seller order', () => {
    const goods = [{ categoryId: FOOD, goods: { amount: 1n, tax: 0n }, units: 1 }];
    expect(saleEntries(order({ paidAt: null }), goods, zone)).toEqual([]);
  });

  it('writes a refund as negative entries on the refund day', () => {
    const refund: RefundFact = {
      refundId: REFUND,
      orderId: ORDER,
      sellerOrderId: SELLER_ORDER,
      sellerId: SELLER,
      currency,
      total: { amount: 2090n, tax: 190n },
      shipping: { amount: 990n, tax: 90n },
      refundedAt: Temporal.Instant.from('2026-11-25T02:00:00Z'),
    };
    const [entry] = refundEntries(
      refund,
      [{ categoryId: UNKNOWN_CATEGORY, goods: { amount: 1100n, tax: 100n }, units: 1 }],
      zone,
    );
    expect(entry).toMatchObject({
      kind: 'refund',
      sourceId: REFUND,
      marketDay: '2026-11-25',
      amount: -1100n,
      tax: -100n,
      units: -1,
    });
  });
});

describe('rollUpSellerDay', () => {
  const day = '2026-11-22' as MarketDay;
  const dayOrder = (overrides: Partial<DaySellerOrder>): DaySellerOrder => ({
    sellerOrderId: 'so-1',
    currency: 'AUD',
    goodsAmount: 1100n,
    goodsTax: 100n,
    units: 1,
    shippingAmount: 0n,
    shippingTax: 0n,
    paidOnDay: false,
    cancelledOnDay: false,
    shippedOnDay: false,
    shippedOnTime: null,
    deliveredOnDay: false,
    ...overrides,
  });

  it('counts each instant on its own day and the goods on the paid day only', () => {
    const rollup = rollUpSellerDay({
      sellerOrders: [
        dayOrder({
          sellerOrderId: 'so-1',
          paidOnDay: true,
          shippedOnDay: true,
          shippedOnTime: true,
        }),
        dayOrder({ sellerOrderId: 'so-2', shippedOnDay: true, shippedOnTime: false }),
        dayOrder({ sellerOrderId: 'so-3', deliveredOnDay: true, cancelledOnDay: true }),
      ],
      refunds: [{ currency: 'AUD', amount: 550n, tax: 50n }],
      entries: [],
    });
    expect(rollup.seller).toEqual([
      expect.objectContaining({
        currency: 'AUD',
        ordersPaid: 1,
        goodsAmount: 1100n,
        goodsTax: 100n,
        units: 1,
        ordersShipped: 2,
        ordersShippedOnTime: 1,
        ordersCancelled: 1,
        ordersDelivered: 1,
        refunds: 1,
        refundAmount: 550n,
        refundTax: 50n,
      }),
    ]);
  });

  it('nets the sales and refunds of a category and counts its distinct seller orders', () => {
    const entry = {
      categoryId: id<'Category'>('c1'),
      orderId: ORDER,
      sellerId: SELLER,
      currency: 'AUD',
      marketDay: day,
    };
    const rollup = rollUpSellerDay({
      sellerOrders: [],
      refunds: [],
      entries: [
        {
          ...entry,
          kind: 'sale',
          sourceId: 'a',
          sellerOrderId: id('a'),
          amount: 1000n,
          tax: 0n,
          units: 2,
        },
        {
          ...entry,
          kind: 'sale',
          sourceId: 'b',
          sellerOrderId: id('b'),
          amount: 500n,
          tax: 0n,
          units: 1,
        },
        {
          ...entry,
          kind: 'refund',
          sourceId: 'r',
          sellerOrderId: id('a'),
          amount: -500n,
          tax: 0n,
          units: -1,
        },
      ],
    });
    expect(rollup.categories).toEqual([
      expect.objectContaining({
        orders: 2,
        salesAmount: 1500n,
        salesUnits: 3,
        refundAmount: -500n,
        refundUnits: -1,
      }),
    ]);
  });

  it('is empty for a day with no fact, so its rows are removed', () => {
    expect(rollUpSellerDay({ sellerOrders: [], refunds: [], entries: [] })).toEqual({
      seller: [],
      categories: [],
    });
  });

  it('keeps one row per currency', () => {
    const rollup = rollUpSellerDay({
      sellerOrders: [
        dayOrder({ paidOnDay: true }),
        dayOrder({ sellerOrderId: 'so-2', currency: 'NZD', paidOnDay: true }),
      ],
      refunds: [],
      entries: [],
    });
    expect(rollup.seller.map((row) => row.currency)).toEqual(['AUD', 'NZD']);
  });
});

describe('distinctSellerDays', () => {
  it('drops repeats and orders by day, then seller', () => {
    const a = { marketDay: '2026-11-22' as MarketDay, sellerId: id<'Seller'>('b') };
    const b = { marketDay: '2026-11-21' as MarketDay, sellerId: id<'Seller'>('z') };
    expect(distinctSellerDays([a, b, a])).toEqual([b, a]);
  });
});
