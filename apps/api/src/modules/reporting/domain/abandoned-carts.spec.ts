import { Temporal } from '@mondapac/shared-kernel';
import {
  ABANDONED_AFTER,
  abandonedCartsDayDue,
  abandonedCartsOf,
  approximateValueOf,
  idleCutoffOf,
  MIN_ABANDONED_CARTS,
  type AbandonedCartsDay,
} from './abandoned-carts';
import type { MarketDay } from './facts';

const day = (text: string) => text as MarketDay;
const money = (amount: bigint, currency: string) => ({ amount, currency });

// Both Market fixtures' zones are ahead of UTC (Brisbane +10, Tokyo +9); a zone behind UTC with
// daylight saving is checked too, so nothing here leans on the UTC day.
describe.each([['Australia/Brisbane'], ['Asia/Tokyo'], ['America/Los_Angeles']])(
  'the abandoned-cart snapshot day in %s',
  (zone) => {
    const startOf = (text: string) =>
      Temporal.PlainDate.from(text).toZonedDateTime({ timeZone: zone }).toInstant();

    it('is yesterday, due two hours after it ended, and only while it has no row', () => {
      const end = startOf('2026-11-25');
      expect(abandonedCartsDayDue(end.add({ minutes: 119 }), zone, false)).toBeNull();
      expect(abandonedCartsDayDue(end.add({ hours: 2 }), zone, false)).toBe('2026-11-24');
      expect(abandonedCartsDayDue(end.add({ hours: 2 }), zone, true)).toBeNull();
      // Late in the next day it is still yesterday's row; a day later it is never written.
      expect(abandonedCartsDayDue(end.add({ hours: 23 }), zone, false)).toBe('2026-11-24');
      expect(abandonedCartsDayDue(startOf('2026-11-26').add({ hours: 3 }), zone, false)).toBe(
        '2026-11-25',
      );
    });

    it('counts carts untouched for 24 hours at the end of the day', () => {
      const cutoff = idleCutoffOf(day('2026-11-24'), zone);
      expect(cutoff).toEqual(startOf('2026-11-25').subtract(ABANDONED_AFTER));
      expect(startOf('2026-11-25').since(cutoff).total({ unit: 'hours' })).toBe(24);
    });
  },
);

describe('approximateValueOf', () => {
  it('takes the Market currency, zero with no line', () => {
    expect(approximateValueOf([money(4126000n, 'AUD')], 'AUD')).toEqual(money(4126000n, 'AUD'));
    expect(approximateValueOf([], 'JPY')).toEqual(money(0n, 'JPY'));
  });

  it('has no value when a line is in another currency (no conversion)', () => {
    expect(approximateValueOf([money(100n, 'AUD'), money(5n, 'JPY')], 'AUD')).toBeNull();
    expect(approximateValueOf([money(5n, 'JPY')], 'AUD')).toBeNull();
  });

  it('refuses a negative or non-integer total', () => {
    expect(() => approximateValueOf([money(-1n, 'AUD')], 'AUD')).toThrow(RangeError);
  });
});

describe('abandonedCartsOf', () => {
  const range = { from: day('2026-11-18'), to: day('2026-11-24') };
  const row = (text: string, carts: number, value: bigint | null): AbandonedCartsDay => ({
    day: day(text),
    carts,
    value: value === null ? null : money(value, 'AUD'),
  });

  it('shows the latest day of the period, never a sum of days', () => {
    const answer = abandonedCartsOf(
      [row('2026-11-20', 30, 9000n), row('2026-11-23', 40, 12000n), row('2026-11-21', 50, 1n)],
      [row('2026-11-16', 20, 1000n), row('2026-11-12', 99, 1n)],
      range,
    );
    expect(answer).toEqual({
      status: 'available',
      carts: 40,
      approximateValue: money(12000n, 'AUD'),
      asOfDay: '2026-11-23',
      change: { value: 10000, direction: 'up', state: 'ok' },
      recordedDays: 3,
      periodDays: 7,
    });
  });

  it('is not-enough-data with no row or fewer than five carts on the latest day', () => {
    expect(abandonedCartsOf([], [], range)).toEqual({
      status: 'not-enough-data',
      minimum: MIN_ABANDONED_CARTS,
      recordedDays: 0,
      periodDays: 7,
    });
    const few = abandonedCartsOf(
      [row('2026-11-20', 30, 1n), row('2026-11-24', MIN_ABANDONED_CARTS - 1, 1n)],
      [],
      range,
    );
    expect(few).toEqual({
      status: 'not-enough-data',
      minimum: MIN_ABANDONED_CARTS,
      recordedDays: 2,
      periodDays: 7,
    });
  });

  it('gives no change when the period before had no row or fewer than five carts', () => {
    const none = abandonedCartsOf([row('2026-11-24', 5, 1n)], [], range);
    expect(none.status === 'available' && none.change.state).toBe('na');
    const few = abandonedCartsOf([row('2026-11-24', 5, 1n)], [row('2026-11-17', 4, 1n)], range);
    expect(few.status === 'available' && few.change.state).toBe('na');
  });

  it('keeps a day without a value (mixed currencies) without a value', () => {
    const answer = abandonedCartsOf([row('2026-11-24', 8, null)], [], range);
    expect(answer.status === 'available' && answer.approximateValue).toBeNull();
  });

  it('refuses a negative count', () => {
    expect(() => abandonedCartsOf([row('2026-11-24', -1, 0n)], [], range)).toThrow(RangeError);
  });
});
