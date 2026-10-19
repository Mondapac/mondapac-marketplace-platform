import { cumulativeShare, unitShares } from './reversal';

describe('unitShares', () => {
  it('splits a line tax evenly, the remainder to the earlier units', () => {
    // 100 over 3 units: 34, 33, 33.
    expect(unitShares(100n, 3, 0, 1)).toBe(34n);
    expect(unitShares(100n, 3, 1, 1)).toBe(33n);
    expect(unitShares(100n, 3, 2, 1)).toBe(33n);
    expect(unitShares(100n, 3, 0, 2)).toBe(67n);
  });

  it('reverses exactly the line tax whatever the parts', () => {
    for (const tax of [0n, 1n, 91n, 100n, 999n, 12345n]) {
      for (const quantity of [1, 2, 3, 7, 99]) {
        let sum = 0n;
        let at = 0;
        for (const part of [1, 2, 3, 5, 99]) {
          const units = Math.min(part, quantity - at);
          if (units === 0) break;
          sum += unitShares(tax, quantity, at, units);
          at += units;
        }
        sum += at < quantity ? unitShares(tax, quantity, at, quantity - at) : 0n;
        expect(sum).toBe(tax);
      }
    }
  });
});

describe('cumulativeShare', () => {
  it('rounds each cumulative point half up', () => {
    // Shipping $11.00 with $1.00 tax: refunding $5.50 reverses $0.50, the rest the other $0.50.
    expect(cumulativeShare(100n, 1100n, 0n, 550n)).toBe(50n);
    expect(cumulativeShare(100n, 1100n, 550n, 1100n)).toBe(50n);
    // $10.00 with $0.91: $3.33 -> 0.30303 -> 30, then to $10.00 -> 61.
    expect(cumulativeShare(91n, 1000n, 0n, 333n)).toBe(30n);
    expect(cumulativeShare(91n, 1000n, 333n, 1000n)).toBe(61n);
  });

  it('telescopes to the whole tax in any parts, and is zero on a zero charge', () => {
    for (const [tax, gross] of [
      [91n, 1000n],
      [150n, 1150n],
      [1n, 3n],
      [0n, 500n],
    ] as const) {
      let before = 0n;
      let sum = 0n;
      for (const step of [1n, 7n, 100n, 333n]) {
        const after = before + step > gross ? gross : before + step;
        sum += cumulativeShare(tax, gross, before, after);
        before = after;
      }
      sum += cumulativeShare(tax, gross, before, gross);
      expect(sum).toBe(tax);
    }
    expect(cumulativeShare(0n, 0n, 0n, 0n)).toBe(0n);
  });
});
