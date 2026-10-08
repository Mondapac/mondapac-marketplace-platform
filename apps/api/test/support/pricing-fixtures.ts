import { testMarketId } from './test-config';
import { Temporal, money } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { priceAmount } from '../../src/modules/pricing/domain/price-amount';
import type { PriceAmount } from '../../src/modules/pricing/domain/price-amount';
import { createPricingPolicy } from '../../src/modules/pricing/domain/pricing-policy';
import type { PricingPolicy } from '../../src/modules/pricing/domain/pricing-policy';
import { PriceSeries } from '../../src/modules/pricing/domain/price-series';

// Test builders for the two Market fixtures (AU, and the synthetic ZZ with JPY, exponent 0,
// tax-exclusive prices, another threshold, window and maximum; pricing design 13).

export interface PricingMarketFixture {
  readonly code: 'AU' | 'ZZ';
  readonly policy: PricingPolicy;
  readonly taxInclusive: boolean;
  /** A price well inside any threshold of this fixture's policy. */
  readonly base: bigint;
}

export const PRICING_FIXTURES: readonly PricingMarketFixture[] = [
  {
    code: 'AU',
    taxInclusive: true,
    base: 10000n,
    policy: createPricingPolicy({
      marketId: testMarketId('AU'),
      currency: 'AUD',
      maxUnitPriceMinor: 500000n,
      thresholdNumerator: 1n,
      thresholdDenominator: 2n,
      jumpDirections: 'both',
      jumpWindow: 'P7D',
    }),
  },
  {
    code: 'ZZ',
    taxInclusive: false,
    base: 1000n,
    policy: createPricingPolicy({
      marketId: testMarketId('ZZ'),
      currency: 'JPY',
      maxUnitPriceMinor: 2000000n,
      thresholdNumerator: 1n,
      thresholdDenominator: 4n,
      jumpDirections: 'up',
      jumpWindow: 'P3D',
    }),
  },
];

export const T0 = Temporal.Instant.from('2026-10-08T10:00:00Z');

export function newClock(): FixedClock {
  return new FixedClock(T0);
}

export function newSeries(
  fixture: PricingMarketFixture,
  clock: FixedClock,
  ids: SequenceIdGenerator,
): PriceSeries {
  return PriceSeries.create({
    id: ids.next<'PriceSeries'>(),
    marketId: testMarketContext(fixture.code, 'default').marketId,
    offerId: ids.next<'Offer'>(),
    variantId: ids.next<'Variant'>(),
    productId: ids.next<'Product'>(),
    sellerId: ids.next<'Seller'>(),
    now: clock.now(),
  });
}

export function amountOf(fixture: PricingMarketFixture, minor: bigint): PriceAmount {
  const result = priceAmount(money(minor, fixture.policy.currency), fixture.policy);
  if (!result.ok) throw new Error(`fixture amount ${minor} refused: ${result.error.code}`);
  return result.value;
}

export { SequenceIdGenerator };
