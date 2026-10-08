import type { MarketId } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PricingNotConfiguredError } from '../application/ports/pricing-policy-provider';
import {
  ConfigPricingPolicyProvider,
  PricingMarketConfigError,
} from './config-pricing-policy-provider';

// The pricing policy of both Market fixtures comes from their files, differs, and a Market
// without a valid section stops the start-up (no default).

const configs = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);
const au = testMarketContext('AU', 'default');
const zz = testMarketContext('ZZ', 'default');

function registryWith(
  marketId: MarketId,
  change: (config: ReturnType<MarketRegistry['get']>) => unknown,
): MarketRegistry {
  const changed = new Map<MarketId, ReturnType<MarketRegistry['get']>>(configs);
  changed.set(marketId, change(configs.get(marketId)!) as ReturnType<MarketRegistry['get']>);
  return new MarketRegistry(changed);
}

describe('ConfigPricingPolicyProvider', () => {
  const provider = new ConfigPricingPolicyProvider(new MarketRegistry(configs));

  it('builds each Market policy from its own file', () => {
    const a = provider.forMarket(au);
    const z = provider.forMarket(zz);

    expect(a).toMatchObject({
      marketId: au.marketId,
      currency: 'AUD',
      thresholdNumerator: 1n,
      thresholdDenominator: 2n,
      jumpDirections: 'both',
      jumpWindowMs: 7 * 24 * 3600 * 1000,
    });
    expect(a.maxUnitPrice.amount).toBe(500000n);
    expect(z).toMatchObject({
      marketId: zz.marketId,
      currency: 'JPY',
      thresholdNumerator: 1n,
      thresholdDenominator: 4n,
      jumpDirections: 'up',
      jumpWindowMs: 3 * 24 * 3600 * 1000,
    });
    expect(z.maxUnitPrice.amount).toBe(2000000n);
  });

  it('answers the same policy object every time', () => {
    expect(provider.forMarket(au)).toBe(provider.forMarket(au));
  });

  it('refuses a Market that is not hosted', () => {
    expect(() => provider.forMarket(testMarketContext('QQ', 'default'))).toThrow(
      PricingNotConfiguredError,
    );
  });

  it('refuses to start when a hosted Market has no pricing section, naming it', () => {
    const registry = registryWith(au.marketId, (c) => ({ ...c, pricing: undefined }));
    expect(() => new ConfigPricingPolicyProvider(registry)).toThrow(PricingMarketConfigError);
    expect(() => new ConfigPricingPolicyProvider(registry)).toThrow(/AU/);
  });

  it.each([
    ['a window under one hour', { jumpWindow: 'PT30M' }],
    ['a zero window', { jumpWindow: 'P0D' }],
    ['a window over ninety days', { jumpWindow: 'P91D' }],
    ['a threshold over one', { jumpThreshold: { numerator: 3, denominator: 2 } }],
  ])('refuses to start with %s', (_name, override) => {
    const registry = registryWith(zz.marketId, (c) => ({
      ...c,
      pricing: { ...c.pricing!, ...override },
    }));
    expect(() => new ConfigPricingPolicyProvider(registry)).toThrow(/ZZ/);
  });
});
