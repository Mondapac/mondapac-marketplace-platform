import { describe, expect, it } from 'vitest';
import type { KpiTotals } from './types.ts';
import { changeOf, deltasOf, percent, pointsChange } from './view.ts';

// The change lines of the KPI cards: colour from better or worse, not from the direction, and
// n/a on a zero or tiny base.

const VS = 'vs previous 7 days';
const totals = (over: Partial<KpiTotals> = {}): KpiTotals => ({
  salesInclTax: '0',
  salesExclTax: '0',
  orders: 10,
  units: 10,
  averageOrderValue: '1000',
  refundedInclTax: '0',
  refunds: 0,
  refundRateBps: 0,
  ordersCancelled: 0,
  ordersShipped: 10,
  shippedOnTimeBps: 9000,
  ...over,
});

describe('changeOf', () => {
  it('signs the change and judges it by what is better', () => {
    expect(changeOf(1125n, 1000n, 10, 'higher-is-better', VS)).toEqual({
      value: '+12.5%',
      direction: 'up',
      sentiment: 'good',
      comparedWith: VS,
    });
    expect(changeOf(1125n, 1000n, 10, 'lower-is-better', VS)).toMatchObject({
      direction: 'up',
      sentiment: 'bad',
    });
    expect(changeOf(750n, 1000n, 10, 'higher-is-better', VS)).toMatchObject({
      value: '-25.0%',
      direction: 'down',
      sentiment: 'bad',
    });
    expect(changeOf(1000n, 1000n, 10, 'higher-is-better', VS)).toMatchObject({
      value: '0.0%',
      direction: 'flat',
      sentiment: 'neutral',
    });
  });

  it('is n/a on a zero base and on a previous period of fewer than five orders', () => {
    expect(changeOf(5n, 0n, 10, 'higher-is-better', VS).value).toBe('n/a');
    expect(changeOf(500n, 100n, 4, 'higher-is-better', VS).value).toBe('n/a');
    expect(changeOf(500n, 100n, 5, 'higher-is-better', VS).value).toBe('+400.0%');
  });
});

describe('pointsChange and percent', () => {
  it('moves a rate in points, and has no change without both rates', () => {
    expect(pointsChange(700, 500, 'lower-is-better', VS)).toMatchObject({
      value: '+2.0 pts',
      sentiment: 'bad',
    });
    expect(pointsChange(9500, 9000, 'higher-is-better', VS)).toMatchObject({ sentiment: 'good' });
    expect(pointsChange(null, 9000, 'higher-is-better', VS).value).toBe('n/a');
  });

  it('prints a rate with one decimal, or a dash', () => {
    expect(percent(666)).toBe('6.7%');
    expect(percent(null)).toBe('-');
  });
});

describe('small bases and nulls', () => {
  it('has no change for a missing current figure or a rounded zero', () => {
    expect(changeOf(null, 1000n, 10, 'higher-is-better', VS).value).toBe('n/a');
    expect(changeOf(10003n, 10000n, 10, 'higher-is-better', VS)).toMatchObject({
      value: '0.0%',
      direction: 'flat',
    });
    expect(pointsChange(502, 500, 'lower-is-better', VS)).toMatchObject({ direction: 'flat' });
  });

  it('shows no points change on a base of fewer than five orders', () => {
    expect(pointsChange(9000, 5000, 'higher-is-better', VS, 1).value).toBe('n/a');
    const d = deltasOf(totals(), totals({ orders: 10, ordersShipped: 2 }), VS);
    expect(d.onTime.value).toBe('n/a');
  });
});

describe('deltasOf', () => {
  it('judges refunds and cancellations the other way round', () => {
    const d = deltasOf(
      totals({ salesInclTax: '2000', refundedInclTax: '300', ordersCancelled: 3 }),
      totals({ salesInclTax: '1000', refundedInclTax: '100', ordersCancelled: 1 }),
      VS,
    );
    expect(d.sales.sentiment).toBe('good');
    expect(d.refunded.sentiment).toBe('bad');
    expect(d.cancelled.sentiment).toBe('bad');
  });
});
