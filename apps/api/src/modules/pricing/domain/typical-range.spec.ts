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
    // median 1790: band 50 -> 895..2685, outward -> 890..2700
    expect(typicalRange(refOf([1790n]), 50)).toEqual({ lowMinor: 890n, highMinor: 2700n });
  });

  it('keeps an even-count half exact before widening', () => {
    // median of 1001 and 1002 = 1001.5; band 50 -> 500.75..1502.25 -> 500..1600
    expect(typicalRange(refOf([1001n, 1002n]), 50)).toEqual({ lowMinor: 500n, highMinor: 1600n });
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

  it('refuses a band that is not a positive whole percent', () => {
    expect(() => typicalRange(refOf([100n]), 0)).toThrow(RangeError);
    expect(() => typicalRange(refOf([100n]), 1.5)).toThrow(RangeError);
  });
});
