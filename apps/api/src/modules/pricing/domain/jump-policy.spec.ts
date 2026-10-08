import { measureJump } from './jump-policy';
import { createPricingPolicy } from './pricing-policy';
import { PRICING_FIXTURES, amountOf } from '../../../../test/support/pricing-fixtures';

// AU: T = 1/2, both ways. ZZ: T = 1/4, up only.
describe.each(PRICING_FIXTURES)('measureJump in market $code', (fixture) => {
  const { policy } = fixture;
  const n = policy.thresholdNumerator;
  const d = policy.thresholdDenominator;
  const anchor = amountOf(fixture, 1200n);
  const upLimit = (1200n * (d + n)) / d;
  const downLimit = (1200n * (d - n)) / d;

  it('does not hold exactly T upward, holds one minor unit more', () => {
    expect(measureJump(anchor, amountOf(fixture, upLimit), policy)).toEqual({ kind: 'within' });
    expect(measureJump(anchor, amountOf(fixture, upLimit + 1n), policy)).toEqual({
      kind: 'held',
      direction: 'up',
    });
  });

  it('holds a drop beyond T only when the policy enables the down direction', () => {
    const verdict = measureJump(anchor, amountOf(fixture, downLimit - 1n), policy);
    expect(verdict).toEqual(
      policy.jumpDirections === 'up' ? { kind: 'within' } : { kind: 'held', direction: 'down' },
    );
    expect(measureJump(anchor, amountOf(fixture, downLimit), policy)).toEqual({ kind: 'within' });
  });

  it('does not hold the same price or a tiny move', () => {
    expect(measureJump(anchor, anchor, policy)).toEqual({ kind: 'within' });
    expect(measureJump(anchor, amountOf(fixture, 1201n), policy)).toEqual({ kind: 'within' });
  });

  it('is exact for amounts beyond the float range', () => {
    const wide = createPricingPolicy({
      marketId: policy.marketId,
      currency: policy.currency,
      maxUnitPriceMinor: BigInt(Number.MAX_SAFE_INTEGER),
      thresholdNumerator: n,
      thresholdDenominator: d,
      jumpDirections: policy.jumpDirections,
      jumpWindow: 'P3D',
    });
    const top = amountOf({ ...fixture, policy: wide }, BigInt(Number.MAX_SAFE_INTEGER));
    const near = amountOf({ ...fixture, policy: wide }, BigInt(Number.MAX_SAFE_INTEGER) - 1n);
    expect(measureJump(top, near, wide)).toEqual({ kind: 'within' });
    // One minor unit past T of a 2^53 - 1 anchor: floats cannot tell these apart.
    const base = BigInt(Number.MAX_SAFE_INTEGER) / 4n;
    const anchorBig = amountOf({ ...fixture, policy: wide }, base);
    const limit = (base * (d + n)) / d;
    const candidate = amountOf({ ...fixture, policy: wide }, limit + 1n);
    expect(measureJump(anchorBig, candidate, wide)).toEqual({ kind: 'held', direction: 'up' });
  });
});
