import { Temporal } from '@mondapac/shared-kernel';
import { orderStatusOf, sameDayShareOf, takeRateOf } from './admin-health';
import { EMPTY_LEDGER_SUMS, netRevenueOf, netRevenueTotalOf, type NetRevenue } from './ledger';
import { windowOf, type DayRange } from './period';
import type { MarketDay } from './facts';

const day = (value: string) => value as MarketDay;

describe('orderStatusOf (dashboards v2: orders by status)', () => {
  it('puts every paid seller order in one bucket: cancelled > refunded > delivered > shipped > to ship', () => {
    const counts = orderStatusOf({
      paid: 100,
      cancelled: 5,
      delivered: 60,
      shipped: 20,
      refunded: { delivered: 3, shipped: 1, toShip: 2 },
    });
    expect(counts).toEqual({
      paid: 100,
      toShip: 13, // 100 - 5 - 60 - 20 - 2
      shipped: 19,
      delivered: 57,
      cancelled: 5,
      refunded: 6,
      cancelledRateBp: 500,
      refundedRateBp: 600,
    });
    expect(
      counts.toShip + counts.shipped + counts.delivered + counts.cancelled + counts.refunded,
    ).toBe(counts.paid);
  });

  it('answers null rates with no paid seller order', () => {
    expect(
      orderStatusOf({
        paid: 0,
        cancelled: 0,
        delivered: 0,
        shipped: 0,
        refunded: { delivered: 0, shipped: 0, toShip: 0 },
      }),
    ).toMatchObject({ paid: 0, toShip: 0, cancelledRateBp: null, refundedRateBp: null });
  });

  it('refuses tallies that cannot be one range (a negative bucket)', () => {
    expect(() =>
      orderStatusOf({
        paid: 3,
        cancelled: 1,
        delivered: 2,
        shipped: 1,
        refunded: { delivered: 0, shipped: 0, toShip: 0 },
      }),
    ).toThrow(RangeError);
  });
});

describe('sameDayShareOf', () => {
  it('is not-available, never 0, until reporting holds the delivery method', () => {
    expect(sameDayShareOf(null)).toEqual({ status: 'not-available', reason: 'not-reported' });
  });

  it('is same-day ÷ paid once it has a source', () => {
    expect(sameDayShareOf({ sameDay: 31, paid: 100 })).toEqual({
      status: 'available',
      sameDay: 31,
      paid: 100,
      rateBp: 3100,
    });
    expect(sameDayShareOf({ sameDay: 0, paid: 0 })).toMatchObject({ rateBp: null });
  });
});

describe('takeRateOf (net revenue ÷ GMV without GST)', () => {
  const sums = (commission: bigint, refunded: bigint) => ({
    ...EMPTY_LEDGER_SUMS,
    commission: { amount: commission, baseAmount: 0n },
    'refund-commission': { amount: refunded, baseAmount: 0n },
  });

  it('is partial while a component is missing: from the available ones only, labelled', () => {
    const net = netRevenueOf(sums(13_500n, 300n), 'AUD');
    expect(takeRateOf(net, 100_000n)).toEqual({
      status: 'partial',
      rateBp: 1320,
      basis: ['commission'],
      missing: ['deliveryMargin', 'platformFundedDiscounts', 'platformFundedCashback', 'fleetFees'],
    });
  });

  it('is complete when net revenue is complete (every component signed)', () => {
    const components: NetRevenue['components'] = {
      commission: { status: 'available', amount: 1_000n },
      deliveryMargin: { status: 'available', amount: 200n },
      platformFundedDiscounts: { status: 'available', amount: 100n },
      platformFundedCashback: { status: 'available', amount: 50n },
      fleetFees: { status: 'available', amount: 50n },
    };
    const net: NetRevenue = {
      currency: 'JPY',
      commissionCharged: 1_000n,
      commissionRefunded: 0n,
      components,
      total: netRevenueTotalOf(components),
    };
    expect(takeRateOf(net, 10_000n)).toEqual({ status: 'complete', rateBp: 1000 });
  });

  it('is no-sales with no GMV', () => {
    expect(takeRateOf(netRevenueOf(sums(0n, 0n), 'AUD'), 0n)).toEqual({ status: 'no-sales' });
  });
});

describe('windowOf (a range of Market days as instants)', () => {
  const range: DayRange = { from: day('2026-11-01'), to: day('2026-11-30') };

  it.each([
    ['Australia/Brisbane', '2026-10-31T14:00:00Z', '2026-11-30T14:00:00Z'],
    ['Asia/Tokyo', '2026-10-31T15:00:00Z', '2026-11-30T15:00:00Z'],
  ])('covers whole days in %s', (zone, from, to) => {
    const window = windowOf(range, zone);
    expect(window.from).toEqual(Temporal.Instant.from(from));
    expect(window.to).toEqual(Temporal.Instant.from(to));
  });
});
