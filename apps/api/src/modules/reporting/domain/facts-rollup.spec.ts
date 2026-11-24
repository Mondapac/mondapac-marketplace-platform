import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  checkedBuyerFirst,
  checkedDelivery,
  keepKnownInstants,
  UNKNOWN_BUYER_FIRST,
  UNKNOWN_DELIVERY,
  type DeliveryFact,
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
    delivery: { method: 'instant', state: null },
    buyerFirst: { order: null, withSeller: null },
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
      refunds: [
        { currency: 'AUD', amount: 550n, tax: 50n, shippingAmount: 110n, shippingTax: 10n },
      ],
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
        refundGoodsAmount: -440n,
        refundGoodsTax: -40n,
        refundShippingAmount: -110n,
        refundShippingTax: -10n,
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

describe('keepKnownInstants', () => {
  it('keeps an instant the stored fact knows and the new read does not', () => {
    const at = Temporal.Instant.from('2026-11-20T00:00:00Z');
    const read = {
      sellerOrderId: 'so' as Id<'SellerOrder'>,
      orderId: 'o' as Id<'Order'>,
      sellerId: 's' as Id<'Seller'>,
      currency: 'AUD',
      goods: { amount: 1n, tax: 0n },
      units: 1,
      shipping: { amount: 0n, tax: 0n },
      paidAt: at,
      cancelledAt: null,
      shippedAt: null,
      shippedOnTime: null,
      deliveredAt: null,
      delivery: { method: 'instant' as const, state: null },
      buyerFirst: { order: null, withSeller: null },
    };
    const later = at.add({ hours: 1 });
    expect(keepKnownInstants(read, null)).toBe(read);
    expect(
      keepKnownInstants(read, {
        paidAt: at,
        cancelledAt: null,
        shippedAt: later,
        shippedOnTime: false,
        deliveredAt: later,
        delivery: { method: null, state: null },
        buyerFirst: { order: null, withSeller: null },
      }),
    ).toEqual({ ...read, shippedAt: later, shippedOnTime: false, deliveredAt: later });
  });
});

describe.each(MARKETS)('delivery facts in market $name', ({ currency }) => {
  const order = (overrides: Partial<SellerOrderFact> = {}): SellerOrderFact => ({
    sellerOrderId: SELLER_ORDER,
    orderId: ORDER,
    sellerId: SELLER,
    currency,
    goods: { amount: 1100n, tax: 100n },
    units: 1,
    shipping: { amount: 0n, tax: 0n },
    paidAt: Temporal.Instant.from('2026-11-20T00:00:00Z'),
    cancelledAt: null,
    shippedAt: null,
    shippedOnTime: null,
    deliveredAt: null,
    delivery: UNKNOWN_DELIVERY,
    buyerFirst: { order: null, withSeller: null },
    ...overrides,
  });

  it('keeps a delivery state as first recorded, and takes a known method from the read', () => {
    // Region codes of each fixture's `shipping.postcodeRegions` (AU QLD and NSW, ZZ ZA and ZB).
    const [first, moved] = currency === 'AUD' ? ['QLD', 'NSW'] : ['ZA', 'ZB'];
    const stored = { ...order(), delivery: { method: 'pickup' as const, state: first } };
    for (const state of [null, moved]) {
      const read = order({ delivery: { method: 'pickup', state } });
      expect(keepKnownInstants(read, stored).delivery).toEqual({ method: 'pickup', state: first });
    }
    // A row recorded before the columns learns both from the read.
    const legacy = { ...order(), delivery: UNKNOWN_DELIVERY };
    const read = order({ delivery: { method: 'same_day', state: first } });
    expect(keepKnownInstants(read, legacy).delivery).toEqual({ method: 'same_day', state: first });
    // An unknown state stays unknown: never guessed.
    const unknown = order({ delivery: { method: 'scheduled', state: null } });
    expect(keepKnownInstants(unknown, legacy).delivery).toEqual({
      method: 'scheduled',
      state: null,
    });
  });

  it('checks a delivery: a known method and a region code of 1 to 3 characters', () => {
    const state = currency === 'AUD' ? 'VIC' : 'ZB';
    expect(checkedDelivery({ method: 'instant', state })).toEqual({ method: 'instant', state });
    expect(checkedDelivery(UNKNOWN_DELIVERY)).toEqual(UNKNOWN_DELIVERY);
    for (const bad of [
      { method: 'instant', state: '4000' },
      { method: 'instant', state: 'qld' },
      { method: null, state },
      { method: 'courier', state: null },
    ]) {
      expect(() => checkedDelivery(bad as DeliveryFact)).toThrow(RangeError);
    }
  });
});

describe('distinctSellerDays', () => {
  it('drops repeats and orders by day, then seller', () => {
    const a = { marketDay: '2026-11-22' as MarketDay, sellerId: id<'Seller'>('b') };
    const b = { marketDay: '2026-11-21' as MarketDay, sellerId: id<'Seller'>('z') };
    expect(distinctSellerDays([a, b, a])).toEqual([b, a]);
  });
});

describe.each(MARKETS)('buyer-first facts in market $name', ({ currency }) => {
  const PAID = Temporal.Instant.from('2026-11-20T00:00:00Z');
  const FIRST = { order: true, withSeller: true };
  const RETURNING = { order: false, withSeller: false };
  const NEW_TO_SELLER = { order: false, withSeller: true };
  const order = (overrides: Partial<SellerOrderFact> = {}): SellerOrderFact => ({
    sellerOrderId: SELLER_ORDER,
    orderId: ORDER,
    sellerId: SELLER,
    currency,
    goods: { amount: 1100n, tax: 100n },
    units: 1,
    shipping: { amount: 0n, tax: 0n },
    paidAt: PAID,
    cancelledAt: null,
    shippedAt: null,
    shippedOnTime: null,
    deliveredAt: null,
    delivery: UNKNOWN_DELIVERY,
    buyerFirst: UNKNOWN_BUYER_FIRST,
    ...overrides,
  });

  it('keeps known flags as first recorded, and learns unknown ones from the read', () => {
    const stored = order({ buyerFirst: FIRST });
    for (const buyerFirst of [UNKNOWN_BUYER_FIRST, RETURNING, NEW_TO_SELLER]) {
      expect(keepKnownInstants(order({ buyerFirst }), stored).buyerFirst).toEqual(FIRST);
    }
    const legacy = order();
    expect(keepKnownInstants(order({ buyerFirst: RETURNING }), legacy).buyerFirst).toEqual(
      RETURNING,
    );
    // Unknown on both sides stays unknown: never guessed.
    expect(keepKnownInstants(order(), legacy).buyerFirst).toEqual(UNKNOWN_BUYER_FIRST);
  });

  it('checks the flags: both or neither, only when paid, a first order first with its seller', () => {
    for (const ok of [UNKNOWN_BUYER_FIRST, FIRST, RETURNING, NEW_TO_SELLER]) {
      expect(checkedBuyerFirst(ok, PAID)).toEqual(ok);
    }
    expect(checkedBuyerFirst(UNKNOWN_BUYER_FIRST, null)).toEqual(UNKNOWN_BUYER_FIRST);
    for (const bad of [
      { order: true, withSeller: null },
      { order: null, withSeller: false },
      { order: true, withSeller: false },
    ]) {
      expect(() => checkedBuyerFirst(bad, PAID)).toThrow(RangeError);
    }
    expect(() => checkedBuyerFirst(RETURNING, null)).toThrow(RangeError);
  });
});
