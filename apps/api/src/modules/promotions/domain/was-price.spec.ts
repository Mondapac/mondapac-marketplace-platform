import { wasPriceEligible } from './was-price';

describe.each([
  ['AU', { windowDays: 90, minDaysAtPrice: 28 }],
  ['ZZ', { windowDays: 60, minDaysAtPrice: 20 }],
] as const)('wasPriceEligible in market %s', (_code, rule) => {
  it('is eligible from the minimum number of days', () => {
    expect(wasPriceEligible(rule.minDaysAtPrice, rule)).toBe(true);
    expect(wasPriceEligible(rule.windowDays, rule)).toBe(true);
  });

  it('is not eligible below the minimum', () => {
    expect(wasPriceEligible(rule.minDaysAtPrice - 1, rule)).toBe(false);
    expect(wasPriceEligible(0, rule)).toBe(false);
  });

  it('fails closed on unknown or impossible history', () => {
    expect(wasPriceEligible(null, rule)).toBe(false);
    expect(wasPriceEligible(rule.windowDays + 1, rule)).toBe(false);
    expect(wasPriceEligible(-1, rule)).toBe(false);
    expect(wasPriceEligible(rule.minDaysAtPrice + 0.5, rule)).toBe(false);
  });
});
