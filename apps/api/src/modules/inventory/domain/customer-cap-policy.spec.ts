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
    expect(cap(market.threshold + 5, market.lineCeiling + 40)).toBe(market.lineCeiling);
  });
});
