import { Temporal } from '@mondapac/shared-kernel';
import { computeSellerHealth, type SellerHealthSettings } from './seller-health';
import {
  sellerHealthInputFromDays,
  windowStart,
  type SellerHealthDay,
  type SellerHealthWindows,
} from './seller-health-days';

const TODAY = Temporal.PlainDate.from('2026-11-10');
const AU_WINDOWS: SellerHealthWindows = { shortDays: 30, longDays: 90 };
const OTHER_WINDOWS: SellerHealthWindows = { shortDays: 7, longDays: 14 };

const day = (iso: string, patch: Partial<SellerHealthDay> = {}): SellerHealthDay => ({
  day: Temporal.PlainDate.from(iso),
  paidOrders: 0,
  readyOrders: 0,
  lateReadyOrders: 0,
  lostDisputes: 0,
  reviewsApproved: 0,
  ratingStarsSum: 0,
  ...patch,
});

describe('windowStart', () => {
  it('is inclusive of today', () => {
    expect(windowStart(TODAY, 1).toString()).toBe('2026-11-10');
    expect(windowStart(TODAY, 30).toString()).toBe('2026-10-12');
  });
});

describe('sellerHealthInputFromDays', () => {
  it('sums each metric over its own window', () => {
    const input = sellerHealthInputFromDays(
      [
        day('2026-11-10', {
          paidOrders: 4,
          readyOrders: 3,
          lateReadyOrders: 1,
          reviewsApproved: 2,
          ratingStarsSum: 9,
        }),
        day('2026-10-12', { paidOrders: 6, readyOrders: 5, lateReadyOrders: 0, lostDisputes: 1 }), // first day of 30
        day('2026-10-11', { paidOrders: 10, readyOrders: 9, lateReadyOrders: 9 }), // 31st day back: long only
        day('2026-08-13', { paidOrders: 50, reviewsApproved: 1, ratingStarsSum: 1 }), // first day of 90
        day('2026-08-12', {
          paidOrders: 999,
          lostDisputes: 9,
          reviewsApproved: 3,
          ratingStarsSum: 15,
        }), // outside
        day('2026-11-11', { paidOrders: 777 }), // the future is outside
      ],
      TODAY,
      AU_WINDOWS,
    );
    expect(input.orders).toBe(4 + 6 + 10 + 50);
    expect(input.lateReady).toEqual({ count: 1, base: 8 });
    expect(input.lostDisputes).toEqual({ count: 1, base: 70 });
    expect(input.customerRating).toEqual({ count: 3, averageHundredths: 333 });
    expect(input.sellerCancellations).toEqual({ count: 0, base: 0 });
    expect(input.reports).toBeNull();
  });

  it('uses the Market windows, not 30 and 90', () => {
    const days = [
      day('2026-11-10', { paidOrders: 2, readyOrders: 2 }),
      day('2026-11-04', { paidOrders: 3, readyOrders: 3, lateReadyOrders: 3 }), // 7th day back
      day('2026-11-03', { paidOrders: 5, readyOrders: 5, lateReadyOrders: 5 }), // short: outside
      day('2026-10-28', { paidOrders: 7 }), // long: first day of 14
      day('2026-10-27', { paidOrders: 100 }), // outside
    ];
    const input = sellerHealthInputFromDays(days, TODAY, OTHER_WINDOWS);
    expect(input.orders).toBe(2 + 3 + 5 + 7);
    expect(input.lateReady).toEqual({ count: 3, base: 5 });
  });

  it('is empty without days', () => {
    expect(sellerHealthInputFromDays([], TODAY, AU_WINDOWS)).toEqual({
      orders: 0,
      sellerCancellations: { count: 0, base: 0 },
      lateReady: { count: 0, base: 0 },
      lostDisputes: { count: 0, base: 0 },
      customerRating: { count: 0, averageHundredths: 0 },
      reports: null,
    });
  });

  it('refuses a broken day, a repeated day and bad windows', () => {
    expect(() =>
      sellerHealthInputFromDays([day('2026-11-10', { paidOrders: -1 })], TODAY, AU_WINDOWS),
    ).toThrow(RangeError);
    expect(() =>
      sellerHealthInputFromDays(
        [day('2026-11-10', { readyOrders: 1, lateReadyOrders: 2 })],
        TODAY,
        AU_WINDOWS,
      ),
    ).toThrow(RangeError);
    expect(() =>
      sellerHealthInputFromDays(
        [day('2026-11-10', { reviewsApproved: 1, ratingStarsSum: 6 })],
        TODAY,
        AU_WINDOWS,
      ),
    ).toThrow(RangeError);
    expect(() =>
      sellerHealthInputFromDays([day('2026-11-10'), day('2026-11-10')], TODAY, AU_WINDOWS),
    ).toThrow(RangeError);
    expect(() => sellerHealthInputFromDays([], TODAY, { shortDays: 90, longDays: 30 })).toThrow(
      RangeError,
    );
    expect(() => sellerHealthInputFromDays([], TODAY, { shortDays: 0, longDays: 30 })).toThrow(
      RangeError,
    );
  });

  it('feeds the formula: the seller cancellations metric stays without data', () => {
    const settings: SellerHealthSettings = {
      minOrders: 10,
      minReviews: 5,
      sellerCancellations: { healthyBelow: 250, atRiskUpTo: 500, zeroAt: 1000 },
      lateReady: { healthyBelow: 400, atRiskUpTo: 1000, zeroAt: 2000 },
      lostDisputes: { healthyBelow: 50, atRiskUpTo: 100, zeroAt: 200 },
      customerRating: { healthyFrom: 400, atRiskFrom: 350, best: 500, zeroAt: 100 },
      reports: { healthyBelow: 1, atRiskUpTo: 2, zeroAt: 5 },
    };
    const input = sellerHealthInputFromDays(
      [day('2026-11-09', { paidOrders: 40, readyOrders: 40, lateReadyOrders: 1 })],
      TODAY,
      AU_WINDOWS,
    );
    const health = computeSellerHealth(input, settings);
    expect(health).toMatchObject({ kind: 'scored', lowestMetric: 'late-ready', band: 'healthy' });
    expect(health.metrics[0]).toEqual({ metric: 'seller-cancellations', kind: 'no-data' });
  });
});
