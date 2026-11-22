import type { MarketDay } from './facts';
import {
  averageMinor,
  emptyDay,
  fillDays,
  financeDeltas,
  financeOf,
  operationsDeltas,
  operationsOf,
  ratioBp,
  rateDelta,
  type DayTotals,
} from './admin-kpi';

// The KPI numbers of the admin dashboard (dashboards upgrade phase 5, design section 4): GMV is
// goods only and never lowered by refunds; refunds count on their own day; a rate with nothing to
// divide is null; days with no fact are zeros.

const day = (text: string): MarketDay => text as MarketDay;
const row = (text: string, fields: Partial<DayTotals> = {}): DayTotals => ({
  ...emptyDay(day(text)),
  ...fields,
});

describe('fillDays', () => {
  it('gives every day of the range a row, zeros for a day with no fact', () => {
    const filled = fillDays({ from: day('2026-11-20'), to: day('2026-11-22') }, [
      row('2026-11-21', { ordersPaid: 3 }),
    ]);
    expect(filled.map((r) => [r.day, r.ordersPaid])).toEqual([
      ['2026-11-20', 0],
      ['2026-11-21', 3],
      ['2026-11-22', 0],
    ]);
  });
});

describe('ratios', () => {
  it('rounds half up in basis points and is null without a denominator', () => {
    expect(ratioBp(1, 3)).toBe(3333);
    expect(ratioBp(2, 3)).toBe(6667);
    expect(ratioBp(1, 8)).toBe(1250);
    expect(ratioBp(5, 0)).toBeNull();
    expect(averageMinor(1001n, 2)).toBe(501n);
    expect(averageMinor(10n, 0)).toBeNull();
  });
});

describe('financeOf', () => {
  const days = [
    row('2026-11-21', { ordersPaid: 2, goodsAmount: 30_000n, goodsTax: 2_727n }),
    row('2026-11-22', {
      ordersPaid: 1,
      goodsAmount: 10_000n,
      goodsTax: 909n,
      refunds: 1,
      refundGoodsAmount: -4_000n,
      refundGoodsTax: -364n,
    }),
  ];

  it('reports GMV with and without tax, refunds apart, net sales and the average order', () => {
    expect(financeOf(days)).toEqual({
      gmvWithTax: 40_000n,
      gmvWithoutTax: 40_000n - 3_636n,
      refundedWithTax: 4_000n,
      refundRateBp: 1000,
      netSalesWithTax: 36_000n,
      averageOrderWithTax: 13_333n,
    });
  });

  it('has null rates and average with no sale, and never a negative refund', () => {
    const none = financeOf([row('2026-11-22')]);
    expect(none.refundRateBp).toBeNull();
    expect(none.averageOrderWithTax).toBeNull();
    expect(none.refundedWithTax).toBe(0n);
  });
});

describe('operationsOf', () => {
  it('counts paid, cancelled, on-time and refunds', () => {
    const out = operationsOf([
      row('2026-11-21', {
        ordersPaid: 10,
        ordersCancelled: 1,
        ordersShipped: 8,
        ordersShippedOnTime: 6,
        refunds: 2,
      }),
    ]);
    expect(out).toEqual({
      ordersPaid: 10,
      ordersCancelled: 1,
      cancelRateBp: 1000,
      ordersShipped: 8,
      onTimeRateBp: 7500,
      refunds: 2,
    });
    expect(operationsOf([row('2026-11-21')]).onTimeRateBp).toBeNull();
  });
});

describe('deltas', () => {
  it('compares rates by points and says n/a when a period has no rate', () => {
    expect(rateDelta(350, 200, true)).toEqual({ value: 150, direction: 'up', state: 'ok' });
    expect(rateDelta(null, 200, true).state).toBe('na');
    expect(rateDelta(350, 200, false).state).toBe('na');
  });

  it('says n/a for a rate whose previous period is too small to judge', () => {
    const before = operationsOf([row('2026-11-21', { ordersPaid: 1, ordersCancelled: 1 })]);
    const now = operationsOf([row('2026-11-22', { ordersPaid: 100, ordersCancelled: 2 })]);
    expect(operationsDeltas(now, before).cancelRateBp.state).toBe('na');
  });

  it('says n/a for a base that is zero or too small', () => {
    const empty = operationsOf([row('2026-11-21')]);
    const some = operationsOf([row('2026-11-22', { ordersPaid: 20 })]);
    expect(operationsDeltas(some, empty).ordersPaid.state).toBe('na');
    const small = operationsOf([row('2026-11-21', { ordersPaid: 4 })]);
    expect(operationsDeltas(some, small).ordersPaid.state).toBe('na');
    const base = operationsOf([row('2026-11-21', { ordersPaid: 10 })]);
    expect(operationsDeltas(some, base).ordersPaid).toEqual({
      value: 10000,
      direction: 'up',
      state: 'ok',
    });
  });

  it('compares money only above a base of 100.00', () => {
    const big = financeOf([row('2026-11-22', { ordersPaid: 1, goodsAmount: 50_000n })]);
    const tiny = financeOf([row('2026-11-21', { ordersPaid: 1, goodsAmount: 5_000n })]);
    expect(financeDeltas(big, tiny).gmvWithTax.state).toBe('na');
    expect(financeDeltas(big, big).gmvWithTax).toEqual({
      value: 0,
      direction: 'flat',
      state: 'ok',
    });
  });
});
