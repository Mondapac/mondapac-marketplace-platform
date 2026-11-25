import { inspect } from 'node:util';
import {
  CostSerializationError,
  costAmount,
  MAX_COST_MINOR,
  restoreCostAmount,
  revealCostMinor,
  sameCost,
} from './cost-amount';

// The opaque Cost type (pricing design 2.2, 6.5; brief s5): it cannot be serialised by accident.

describe.each([
  ['AUD', 1_250n],
  ['JPY', 980n],
] as const)('CostAmount in %s', (currency, amount) => {
  const value = () => {
    const made = costAmount(amount, currency, currency);
    if (!made.ok) throw new Error('fixture');
    return made.value;
  };

  it('holds the amount in the Market currency, read only through revealCostMinor', () => {
    expect(revealCostMinor(value())).toEqual({ amount, currency });
  });

  it('throws on JSON, string, number and template use; inspection shows no value', () => {
    const cost = value();
    expect(() => JSON.stringify({ cost })).toThrow(CostSerializationError);
    expect(() => String(cost)).toThrow(CostSerializationError);
    expect(() => `${cost as unknown as string}`).toThrow(CostSerializationError);
    expect(() => Number(cost)).toThrow(CostSerializationError);
    expect(inspect({ cost })).not.toContain(amount.toString());
    expect(Object.keys(cost)).toEqual([]);
  });

  it('refuses another currency, zero, a negative and an amount above 2^53 - 1', () => {
    const other = currency === 'AUD' ? 'JPY' : 'AUD';
    expect(costAmount(amount, other, currency)).toEqual({
      ok: false,
      error: { code: 'pricing.currency-mismatch' },
    });
    for (const bad of [0n, -1n, MAX_COST_MINOR + 1n]) {
      expect(costAmount(bad, currency, currency)).toEqual({
        ok: false,
        error: { code: 'pricing.amount-out-of-range' },
      });
    }
    expect(costAmount(MAX_COST_MINOR, currency, currency).ok).toBe(true);
  });

  it('compares by value; none equals only none', () => {
    expect(sameCost(value(), restoreCostAmount(amount, currency))).toBe(true);
    expect(sameCost(value(), restoreCostAmount(amount + 1n, currency))).toBe(false);
    expect(sameCost(null, null)).toBe(true);
    expect(sameCost(value(), null)).toBe(false);
  });

  it('refuses to restore a stored amount out of range', () => {
    expect(() => restoreCostAmount(0n, currency)).toThrow('out of range');
  });
});
