import { ownSaleSplit } from './seller-payout';

describe('ownSaleSplit', () => {
  it('the seller pays all of its own sale discount', () => {
    expect(ownSaleSplit(2000n, 1000)).toEqual({
      discount: 200n,
      sellerFunded: 200n,
      platformFunded: 0n,
      shopperPays: 1800n,
    });
  });

  it('floors the discount', () => {
    expect(ownSaleSplit(999n, 333).discount).toBe(33n);
    expect(ownSaleSplit(1n, 1).discount).toBe(0n);
  });

  it('adds up and refuses a price or a rate out of range', () => {
    const split = ownSaleSplit(123456n, 7000);
    expect(split.shopperPays + split.discount).toBe(123456n);
    expect(() => ownSaleSplit(0n, 1000)).toThrow(RangeError);
    expect(() => ownSaleSplit(5n, 0)).toThrow(RangeError);
    expect(() => ownSaleSplit(5n, 10001)).toThrow(RangeError);
  });
});
