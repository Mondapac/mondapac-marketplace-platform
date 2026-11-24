import { Temporal } from '@mondapac/shared-kernel';
import { csvLine } from '@mondapac/platform-import';
import { emptyDay, type DayTotals } from './admin-kpi';
import {
  MARKETPLACE_DAILY_HEADER,
  marketplaceDailyRows,
  moneyCell,
  SELLER_DAILY_HEADER,
  sellerDailyRows,
} from './daily-export';
import type { MarketDay } from './facts';
import type { SellerKpiDayRow } from './seller-kpis';

const day = (text: string) => text as MarketDay;

describe('the daily export rows (dashboards v2, PR 5)', () => {
  it.each([
    ['AUD', 'AU'],
    ['NZD', 'ZZ'],
  ])('writes one row per day of the range in %s, zero days included', (currency) => {
    const sold: DayTotals = {
      ...emptyDay(day('2026-10-02')),
      ordersPaid: 3,
      goodsAmount: 3300n,
      goodsTax: 300n,
      ordersCancelled: 1,
      ordersShipped: 2,
      ordersShippedOnTime: 1,
      ordersDelivered: 1,
      refunds: 1,
      refundGoodsAmount: -1100n,
      refundGoodsTax: -100n,
    };
    const rows = marketplaceDailyRows(
      { from: day('2026-10-01'), to: day('2026-10-03') },
      currency,
      [sold],
    );
    expect(MARKETPLACE_DAILY_HEADER).toHaveLength(rows[0]!.length);
    expect(rows).toEqual([
      ['2026-10-01', currency, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      ['2026-10-02', currency, 3300, 3000, 1100, 2200, 3, 1, 2, 1, 1, 1],
      ['2026-10-03', currency, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ]);
  });

  it('writes the seller rows with refunds as positive goods and shipping', () => {
    const row: SellerKpiDayRow = {
      marketDay: day('2026-10-02'),
      ordersPaid: 2,
      goodsAmount: 2200n,
      goodsTax: 200n,
      units: 5,
      ordersCancelled: 0,
      ordersShipped: 2,
      ordersShippedOnTime: 2,
      refunds: 1,
      refundGoodsAmount: -550n,
      refundGoodsTax: -50n,
      refundShippingAmount: -100n,
      refundShippingTax: 0n,
      refreshedAt: Temporal.Instant.from('2026-10-02T03:00:00Z'),
    };
    const rows = sellerDailyRows({ from: day('2026-10-02'), to: day('2026-10-03') }, 'AUD', [row]);
    expect(SELLER_DAILY_HEADER).toHaveLength(rows[0]!.length);
    expect(rows).toEqual([
      ['2026-10-02', 'AUD', 2200, 2000, 2, 5, 650, 1, 0, 2, 2],
      ['2026-10-03', 'AUD', 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ]);
  });

  it('writes a negative net amount as a number, never as a guarded text', () => {
    const refundOnly: DayTotals = {
      ...emptyDay(day('2026-10-01')),
      refunds: 1,
      refundGoodsAmount: -500n,
    };
    const [row] = marketplaceDailyRows({ from: day('2026-10-01'), to: day('2026-10-01') }, 'AUD', [
      refundOnly,
    ]);
    expect(csvLine(row!)).toBe('2026-10-01,AUD,0,0,500,-500,0,0,0,0,0,1\r\n');
    // An amount past 2^53 stays exact, as text.
    expect(moneyCell(9_007_199_254_740_993n)).toBe('9007199254740993');
    expect(moneyCell(-12n)).toBe(-12);
  });
});
