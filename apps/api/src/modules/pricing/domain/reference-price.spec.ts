import type { Id } from '@mondapac/shared-kernel';
import {
  measureAgainstReference,
  referenceAmountMinor,
  referencePrice,
  type ReferencePrice,
} from './reference-price';

const seller = (n: number) =>
  `00000000-0000-7000-8000-${String(n).padStart(12, '0')}` as Id<'Seller'>;
const at = (n: number, amountMinor: bigint) => ({ sellerId: seller(n), amountMinor });

describe('referencePrice (R4)', () => {
  it('has no reference below the number of businesses the Market needs', () => {
    expect(referencePrice([at(1, 100n), at(2, 120n)], 3)).toEqual({
      kind: 'no-reference',
      businesses: 2,
    });
    expect(referencePrice([], 3)).toEqual({ kind: 'no-reference', businesses: 0 });
  });

  it('counts one business once, however many Offers it lists', () => {
    const answer = referencePrice([at(1, 100n), at(1, 1n), at(1, 1n), at(2, 120n)], 3);
    expect(answer).toEqual({ kind: 'no-reference', businesses: 2 });
  });

  it('takes the median of an odd count exactly', () => {
    const answer = referencePrice([at(1, 1140n), at(2, 900n), at(3, 5000n)], 3);
    expect(answer).toEqual({
      kind: 'reference',
      reference: { doubledMinor: 2280n, businesses: 3 },
    });
  });

  it('keeps the half of an even count instead of rounding it', () => {
    const answer = referencePrice([at(1, 100n), at(2, 101n), at(3, 1n), at(4, 900n)], 3);
    expect(answer).toEqual({ kind: 'reference', reference: { doubledMinor: 201n, businesses: 4 } });
  });

  it('gives a business with many Offers one vote, its own lower median', () => {
    // Business 1 lists 1, 1 and 1000: its vote is 1, not three votes.
    const answer = referencePrice(
      [at(1, 1n), at(1, 1n), at(1, 1000n), at(2, 500n), at(3, 600n)],
      3,
    );
    expect(answer).toEqual({
      kind: 'reference',
      reference: { doubledMinor: 1000n, businesses: 3 },
    });
  });

  it('refuses a bad count or price', () => {
    expect(() => referencePrice([], 0)).toThrow(RangeError);
    expect(() => referencePrice([at(1, 0n)], 1)).toThrow(RangeError);
  });
});

describe('measureAgainstReference (R4 band)', () => {
  const median = (minor: bigint): ReferencePrice => ({ doubledMinor: minor * 2n, businesses: 3 });

  it('holds a price more than the band above or below, and keeps the edge within', () => {
    const ref = median(1000n);
    expect(measureAgainstReference(1500n, ref, 50)).toEqual({ kind: 'within' });
    expect(measureAgainstReference(1501n, ref, 50)).toEqual({ kind: 'outside', direction: 'up' });
    expect(measureAgainstReference(500n, ref, 50)).toEqual({ kind: 'within' });
    expect(measureAgainstReference(499n, ref, 50)).toEqual({ kind: 'outside', direction: 'down' });
  });

  it('catches the typo of the design (50 for 5.00) against an even median', () => {
    // Median of 1140 and 1141 is 1140.5; a price of 5000 is far above, 500 far below.
    const ref: ReferencePrice = { doubledMinor: 2281n, businesses: 4 };
    expect(measureAgainstReference(5000n, ref, 50)).toEqual({ kind: 'outside', direction: 'up' });
    expect(measureAgainstReference(500n, ref, 50)).toEqual({ kind: 'outside', direction: 'down' });
    // 1.5 x 1140.5 = 1710.75: 1710 is within, 1711 is not.
    expect(measureAgainstReference(1710n, ref, 50)).toEqual({ kind: 'within' });
    expect(measureAgainstReference(1711n, ref, 50)).toEqual({ kind: 'outside', direction: 'up' });
  });

  it('never holds a fall with a band of 100 or more', () => {
    expect(measureAgainstReference(1n, median(1000n), 100)).toEqual({ kind: 'within' });
    expect(measureAgainstReference(1n, median(1000n), 200)).toEqual({ kind: 'within' });
    expect(measureAgainstReference(3001n, median(1000n), 200)).toEqual({
      kind: 'outside',
      direction: 'up',
    });
  });

  it('refuses a band that is not a positive whole percent', () => {
    expect(() => measureAgainstReference(1n, median(1n), 0)).toThrow(RangeError);
    expect(() => measureAgainstReference(1n, median(1n), 1.5)).toThrow(RangeError);
  });

  it('rounds the stored copy half up', () => {
    expect(referenceAmountMinor({ doubledMinor: 2281n, businesses: 4 })).toBe(1141n);
    expect(referenceAmountMinor({ doubledMinor: 2280n, businesses: 3 })).toBe(1140n);
  });
});
