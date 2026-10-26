import { retryPauseMs } from './prisma-unit-of-work';

// The pause between attempts of a read-write unit (P 3.1 row 7): short, random, and wider after
// each failed attempt, so units that conflicted do not come back at the same moment.

describe('retryPauseMs', () => {
  it.each([
    [1, 5, 55],
    [2, 5, 105],
  ])('after attempt %i stays between %i and %i ms', (attempt, low, high) => {
    expect(retryPauseMs(attempt, () => 0)).toBe(low);
    expect(retryPauseMs(attempt, () => 0.999_999)).toBe(high - 1);
  });

  it('widens the range after each failed attempt', () => {
    const top = (attempt: number) => retryPauseMs(attempt, () => 0.999_999);

    expect(top(2)).toBeGreaterThan(top(1));
  });

  it('uses the random source it is given', () => {
    expect(retryPauseMs(1, () => 0.5)).toBe(30);
    expect(retryPauseMs(2, () => 0.5)).toBe(55);
  });
});
