import { money } from '@mondapac/shared-kernel';
import { priceAmount } from './price-amount';
import { PRICING_FIXTURES } from '../../../../test/support/pricing-fixtures';

describe.each(PRICING_FIXTURES)('priceAmount in market $code', (fixture) => {
  const { policy } = fixture;
  const max = policy.maxUnitPrice.amount;

  it('accepts one unit and the maximum, in the Market currency', () => {
    expect(priceAmount(money(1n, policy.currency), policy).ok).toBe(true);
    expect(priceAmount(money(max, policy.currency), policy).ok).toBe(true);
  });

  it('refuses zero, a negative amount and an amount above the maximum', () => {
    for (const amount of [0n, -1n, max + 1n]) {
      expect(priceAmount(money(amount, policy.currency), policy)).toEqual({
        ok: false,
        error: { code: 'pricing.amount-out-of-range' },
      });
    }
  });

  it('refuses another currency before it looks at the amount', () => {
    const other = policy.currency === 'AUD' ? 'JPY' : 'AUD';
    expect(priceAmount(money(100n, other), policy)).toEqual({
      ok: false,
      error: { code: 'pricing.currency-mismatch' },
    });
    expect(priceAmount(money(0n, other), policy).ok).toBe(false);
  });
});
