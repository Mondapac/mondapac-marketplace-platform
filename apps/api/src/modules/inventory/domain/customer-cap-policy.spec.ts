import { CustomerCapPolicy } from './customer-cap-policy';
import { availabilityOf } from './stock';

// Fixtures: AU (D 10, ceiling 99, threshold 10) and ZZ (D 4, ceiling 50, threshold 3).
describe.each([
  ['AU', { defaultCap: 10, lineCeiling: 99, threshold: 10 }],
  ['ZZ', { defaultCap: 4, lineCeiling: 50, threshold: 3 }],
] as const)('CustomerCapPolicy in market %s', (_code, market) => {
  const cap = (sellable: number, purchaseLimit: number | null = null) =>
    CustomerCapPolicy.capOf({
      purchaseLimit,
      availability: availabilityOf(sellable, market.threshold),
      defaultCap: market.defaultCap,
      lineCeiling: market.lineCeiling,
      lowStockThreshold: market.threshold,
    });

  it('is D while the status is in-stock, and says nothing about the real count', () => {
    expect(cap(market.threshold + 1)).toBe(market.defaultCap);
    expect(cap(market.threshold + 50)).toBe(market.defaultCap);
  });

  it('is min(D, ceil(onlyLeft / 2)) while low, rounded up so one unit can be taken (AC 1)', () => {
    expect(cap(1)).toBe(1);
    expect(cap(2)).toBe(1);
    expect(cap(3)).toBe(Math.min(market.defaultCap, 2));
    expect(cap(market.threshold)).toBe(
      Math.min(market.defaultCap, Math.ceil(market.threshold / 2)),
    );
  });

  it('is the Offer limit when the Offer has one, low or not', () => {
    expect(cap(1, 7)).toBe(7);
    expect(cap(market.threshold + 5, 2)).toBe(2);
  });

  it('never exceeds the Market line ceiling', () => {
    // Low status keeps the Offer limit, so only the ceiling can bring it down.
    expect(cap(1, market.lineCeiling + 40)).toBe(market.lineCeiling);
  });

  describe('cap oracle (M1): an in-stock unit shows only "more than the threshold"', () => {
    const inStock = (threshold: number, sellable: number, limit: number | null, ceiling = 99) =>
      CustomerCapPolicy.capOf({
        purchaseLimit: limit,
        availability: availabilityOf(sellable, threshold),
        defaultCap: market.defaultCap,
        lineCeiling: ceiling,
        lowStockThreshold: threshold,
      });

    it('limits an Offer limit above threshold + 1 to threshold + 1', () => {
      expect(inStock(market.threshold, market.threshold + 1, 50)).toBe(market.threshold + 1);
      expect(inStock(market.threshold, market.threshold + 30, 50)).toBe(market.threshold + 1);
    });

    it('with threshold 0 an in-stock line can take 1 unit and no more', () => {
      expect(inStock(0, 1, null)).toBe(1);
      expect(inStock(0, 40, 50)).toBe(1);
    });

    it('never asks for more than an in-stock unit has: cap <= sellable whenever in-stock', () => {
      for (const threshold of [0, 1, market.threshold, 20]) {
        for (let sellable = threshold + 1; sellable < threshold + 40; sellable += 1) {
          for (const limit of [null, 1, 5, 50, 99]) {
            expect(inStock(threshold, sellable, limit)).toBeLessThanOrEqual(sellable);
          }
        }
      }
    });

    it('a low unit keeps the Offer limit (the count is public there)', () => {
      expect(inStock(market.threshold, 3, 50)).toBe(50);
    });
  });
});
