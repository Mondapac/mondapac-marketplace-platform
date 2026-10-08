import { parseMarketId, type MarketId } from '@mondapac/shared-kernel';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { assertCatalogConfigured, CatalogMarketConfigError } from './market-config-boot-check';

describe('assertCatalogConfigured', () => {
  const configs = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);

  it('accepts a Region Stack whose hosted Markets all have the catalog section', () => {
    expect(() => assertCatalogConfigured(new MarketRegistry(configs))).not.toThrow();
  });

  it('refuses to start when a hosted Market has none, naming the Market', () => {
    const au = parseMarketId('AU');
    if (!au.ok) throw new Error('AU must parse');
    const without = new Map<MarketId, ReturnType<MarketRegistry['get']>>(configs);
    without.set(au.value, { ...configs.get(au.value)!, catalog: undefined });

    expect(() => assertCatalogConfigured(new MarketRegistry(without))).toThrow(
      CatalogMarketConfigError,
    );
    expect(() => assertCatalogConfigured(new MarketRegistry(without))).toThrow(/AU/);
  });
});
