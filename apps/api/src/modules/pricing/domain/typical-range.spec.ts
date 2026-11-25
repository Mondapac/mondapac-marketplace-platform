import type { Id } from '@mondapac/shared-kernel';
import { referencePrice } from './reference-price';
import { typicalRange } from './typical-range';

const seller = (n: number) => `seller-${n}` as unknown as Id<'Seller'>;
const refOf = (prices: bigint[]) => {
  const answer = referencePrice(
    prices.map((amountMinor, i) => ({ sellerId: seller(i), amountMinor })),
    1,
  );
  if (answer.kind !== 'reference') throw new Error('fixture');
  return answer.reference;
};

describe('typicalRange', () => {
  it('moves the reference by the band and widens to two significant digits', () => {
    // median 1790 -> bucket 1800; band 50 -> 900..2700
    expect(typicalRange(refOf([1790n]), 50)).toEqual({ lowMinor: 900n, highMinor: 2700n });
  });

  it('keeps an even-count half exact before widening', () => {
    // median of 1001 and 1002 = 1001.5 -> 1002 -> bucket 1000; band 50 -> 500..1500
    expect(typicalRange(refOf([1001n, 1002n]), 50)).toEqual({ lowMinor: 500n, highMinor: 1500n });
  });

  it('never goes below one minor unit and handles bands of 100 or more', () => {
    expect(typicalRange(refOf([5n]), 100).lowMinor).toBe(1n);
    expect(typicalRange(refOf([5n]), 150).lowMinor).toBe(1n);
    expect(typicalRange(refOf([1n]), 50).lowMinor).toBe(1n);
  });

  it('is a range that always contains the reference and is not the reference', () => {
    for (const p of [1n, 7n, 99n, 100n, 12345n, 9999999n]) {
      const r = typicalRange(refOf([p]), 50);
      expect(r.lowMinor <= p && p <= r.highMinor).toBe(true);
      expect(r.lowMinor < r.highMinor).toBe(true);
    }
  });

  it('hides small medians: edges are never the exact half or double, and many medians share a range', () => {
    const seen = new Set<string>();
    for (let m = 20n; m < 400n; m += 1n) {
      const r = typicalRange(refOf([m]), 50);
      expect(r.lowMinor % 10n === 0n || r.lowMinor === 1n).toBe(true);
      expect(r.highMinor % 10n).toBe(0n);
      seen.add(`${r.lowMinor}-${r.highMinor}`);
    }
    expect(seen.size).toBeLessThan(380 / 4);
  });

  it('keeps digit boundaries sane (99, 100, 101, 999, 1000) and very large values', () => {
    for (const m of [99n, 100n, 101n, 999n, 1000n, 123_456_789_012n]) {
      const r = typicalRange(refOf([m]), 50);
      expect(r.lowMinor <= m && m <= r.highMinor).toBe(true);
      expect(r.lowMinor >= 1n).toBe(true);
    }
  });

  it('refuses a band that is not a positive whole percent', () => {
    expect(() => typicalRange(refOf([100n]), 0)).toThrow(RangeError);
    expect(() => typicalRange(refOf([100n]), 1.5)).toThrow(RangeError);
  });
});
