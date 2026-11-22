import { Temporal } from '@mondapac/shared-kernel';
import { reportAmount, shippedOnTimeOf } from './report-facts';

const PAID = Temporal.Instant.from('2026-11-22T00:00:00Z');
const promise = {
  deliveryMethod: 'instant' as const,
  deliveryWindow: null,
  readyPrepMinutes: 60,
  readyAt: null,
  shippedAt: null,
};

describe('reportAmount', () => {
  it('keeps an inclusive price, adds the tax to an exclusive one, and counts an unknown tax as 0', () => {
    expect(reportAmount(1100n, 100n, true)).toEqual({ amount: 1100n, tax: 100n });
    expect(reportAmount(1000n, 150n, false)).toEqual({ amount: 1150n, tax: 150n });
    expect(reportAmount(500n, null, null)).toEqual({ amount: 500n, tax: 0n });
  });
});

describe('shippedOnTimeOf', () => {
  const order = { confirmedAt: PAID };
  const at = (minutes: number) => PAID.add({ minutes });

  it('is on time when handed over by the ready-by promise, ready before shipped', () => {
    expect(shippedOnTimeOf(order, { ...promise, readyAt: at(60) }, at(500))).toBe(true);
    expect(
      shippedOnTimeOf(order, { ...promise, readyAt: at(61), shippedAt: at(10) }, at(500)),
    ).toBe(false);
    expect(shippedOnTimeOf(order, { ...promise, shippedAt: at(30) }, at(500))).toBe(true);
  });

  it('is unknown within the promise unshipped, and late once it passed', () => {
    expect(shippedOnTimeOf(order, promise, at(30))).toBeNull();
    expect(shippedOnTimeOf(order, promise, at(61))).toBe(false);
  });

  it('is unknown without a promise', () => {
    expect(shippedOnTimeOf(order, { ...promise, readyPrepMinutes: null }, at(500))).toBeNull();
    expect(shippedOnTimeOf({ confirmedAt: null }, promise, at(500))).toBeNull();
  });
});
