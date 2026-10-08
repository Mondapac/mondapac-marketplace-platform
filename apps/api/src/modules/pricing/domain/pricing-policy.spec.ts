import { InvalidPricingPolicyError, createPricingPolicy, windowStart } from './pricing-policy';
import { testMarketId } from '../../../../test/support/test-config';
import { T0 } from '../../../../test/support/pricing-fixtures';

const VALID = {
  marketId: testMarketId('AU'),
  currency: 'AUD',
  maxUnitPriceMinor: 500000n,
  thresholdNumerator: 1n,
  thresholdDenominator: 2n,
  jumpDirections: 'both',
  jumpWindow: 'P7D',
} as const;

describe('createPricingPolicy', () => {
  it('builds a frozen policy and reads the window as exact time', () => {
    const policy = createPricingPolicy(VALID);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(policy.maxUnitPrice).toEqual({ amount: 500000n, currency: 'AUD' });
    expect(windowStart(T0, policy).toString()).toBe('2026-10-01T10:00:00Z');
    expect(policy.jumpWindowMs).toBe(7 * 24 * 3600_000);
  });

  it.each([
    ['PT36H', '2026-10-06T22:00:00Z'],
    ['P1DT12H', '2026-10-06T22:00:00Z'],
    ['PT90M', '2026-10-08T08:30:00Z'],
  ])('accepts the window %s', (window, start) => {
    expect(windowStart(T0, createPricingPolicy({ ...VALID, jumpWindow: window })).toString()).toBe(
      start,
    );
  });

  it.each([
    ['an unknown currency', { currency: 'ZZZ' }, 'pricing-policy.currency-invalid'],
    ['a zero maximum', { maxUnitPriceMinor: 0n }, 'pricing-policy.max-unit-price-invalid'],
    [
      'a maximum above 2^53 - 1',
      { maxUnitPriceMinor: 2n ** 53n },
      'pricing-policy.max-unit-price-invalid',
    ],
    ['a zero threshold', { thresholdNumerator: 0n }, 'pricing-policy.threshold-invalid'],
    ['a threshold above 1', { thresholdNumerator: 3n }, 'pricing-policy.threshold-invalid'],
    [
      'a huge denominator',
      { thresholdDenominator: 2n ** 40n, thresholdNumerator: 1n },
      'pricing-policy.threshold-invalid',
    ],
    ['unknown directions', { jumpDirections: 'sideways' }, 'pricing-policy.directions-invalid'],
    ['a calendar window', { jumpWindow: 'P1W' }, 'pricing-policy.window-invalid'],
    ['a month window', { jumpWindow: 'P1M' }, 'pricing-policy.window-invalid'],
    ['a malformed window', { jumpWindow: '7 days' }, 'pricing-policy.window-invalid'],
    ['a window under an hour', { jumpWindow: 'PT30M' }, 'pricing-policy.window-invalid'],
    ['a window over 90 days', { jumpWindow: 'P91D' }, 'pricing-policy.window-invalid'],
  ])('refuses %s', (_name, override, code) => {
    let thrown: unknown;
    try {
      createPricingPolicy({ ...VALID, ...override });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidPricingPolicyError);
    expect((thrown as InvalidPricingPolicyError).reason.code).toBe(code);
  });
});
