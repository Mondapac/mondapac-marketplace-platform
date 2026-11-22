import { Temporal, type Id } from '@mondapac/shared-kernel';
import type { MarketDay } from './facts';
import { resolvePeriod } from './period';
import {
  buildSellerKpis,
  totalsOf,
  type SellerKpiCategoryRow,
  type SellerKpiDayRow,
} from './seller-kpis';

// The seller's KPIs from the daily rows: sums with and without GST, the refund sign, rates with a
// null base, a series with a row for every day, and the top categories.

const day = (text: string) => text as MarketDay;
const cat = (n: number) => `0190f000-0000-7000-8000-0000000000d${n}` as Id<'Category'>;
const row = (text: string, over: Partial<SellerKpiDayRow> = {}): SellerKpiDayRow => ({
  marketDay: day(text),
  ordersPaid: 0,
  goodsAmount: 0n,
  goodsTax: 0n,
  units: 0,
  ordersCancelled: 0,
  ordersShipped: 0,
  ordersShippedOnTime: 0,
  refunds: 0,
  refundGoodsAmount: 0n,
  refundGoodsTax: 0n,
  refundShippingAmount: 0n,
  refundShippingTax: 0n,
  refreshedAt: Temporal.Instant.from('2026-11-22T01:00:00Z'),
  ...over,
});

describe('totalsOf', () => {
  it('adds the rows, with and without GST, and turns refunds into positive figures', () => {
    const totals = totalsOf([
      row('2026-11-20', {
        ordersPaid: 2,
        goodsAmount: 11000n,
        goodsTax: 1000n,
        units: 5,
        ordersShipped: 2,
        ordersShippedOnTime: 1,
        ordersCancelled: 1,
      }),
      row('2026-11-21', {
        ordersPaid: 1,
        goodsAmount: 5500n,
        goodsTax: 500n,
        units: 1,
        refunds: 1,
        refundGoodsAmount: -1100n,
        refundShippingAmount: -550n,
      }),
    ]);
    expect(totals.salesInclTax).toBe(16500n);
    expect(totals.salesExclTax).toBe(15000n);
    expect(totals.orders).toBe(3);
    expect(totals.averageOrderValue).toBe(5500n);
    expect(totals.refundedInclTax).toBe(1650n);
    expect(totals.refunds).toBe(1);
    expect(totals.refundRateBps).toBe(666); // 1100 / 16500
    expect(totals.shippedOnTimeBps).toBe(5000);
    expect(totals.ordersCancelled).toBe(1);
  });

  it('leaves the rates and the average empty when there is nothing to divide by', () => {
    const totals = totalsOf([]);
    expect(totals.averageOrderValue).toBeNull();
    expect(totals.refundRateBps).toBeNull();
    expect(totals.shippedOnTimeBps).toBeNull();
    expect(totals.salesInclTax).toBe(0n);
  });
});

describe('buildSellerKpis', () => {
  const period = resolvePeriod('7d', day('2026-11-22'));

  it('splits the rows between the two ranges and ignores a day outside both', () => {
    const kpis = buildSellerKpis(
      period,
      [
        row('2026-11-08', { ordersPaid: 9, goodsAmount: 9n }),
        row('2026-11-10', { ordersPaid: 1, goodsAmount: 100n }),
        row('2026-11-22', { ordersPaid: 2, goodsAmount: 300n }),
      ],
      [],
    );
    expect(kpis.current.orders).toBe(2);
    expect(kpis.previous.orders).toBe(1);
    expect(kpis.series).toHaveLength(7);
    expect(kpis.previousSeries).toHaveLength(7);
    expect(kpis.series[6]).toMatchObject({ day: '2026-11-22', salesInclTax: 300n, orders: 2 });
    expect(kpis.series[0]).toMatchObject({ day: '2026-11-16', salesInclTax: 0n, orders: 0 });
    expect(kpis.refreshedAt?.toString()).toBe('2026-11-22T01:00:00Z');
  });

  it('has no refresh time when the period has no row', () => {
    expect(buildSellerKpis(period, [], []).refreshedAt).toBeNull();
  });

  it('ranks categories by sales minus refunds, best first, five at most, no loss-makers', () => {
    const categories: SellerKpiCategoryRow[] = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
      categoryId: cat(n),
      orders: n,
      salesAmount: BigInt(n * 100),
      salesTax: 0n,
      salesUnits: n,
      refundAmount: n === 7 ? -700n : 0n,
    }));
    const top = buildSellerKpis(period, [], categories).topCategories;
    expect(top.map((c) => c.categoryId)).toEqual([cat(6), cat(5), cat(4), cat(3), cat(2)]);
    expect(top[0]).toMatchObject({ netSalesInclTax: 600n, orders: 6, units: 6 });
  });
});
