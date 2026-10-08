import { parseMarketId, type MarketId } from '@mondapac/shared-kernel';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { assertInventoryConfigured, InventoryMarketConfigError } from './market-config-boot-check';

describe('assertInventoryConfigured', () => {
  const configs = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);

  it('accepts a Region Stack whose hosted Markets all have the inventory section', () => {
    expect(() => assertInventoryConfigured(new MarketRegistry(configs))).not.toThrow();
  });

  it('refuses to start when a hosted Market has none, naming the Market', () => {
    const au = parseMarketId('AU');
    if (!au.ok) throw new Error('AU must parse');
    const without = new Map<MarketId, ReturnType<MarketRegistry['get']>>(configs);
    without.set(au.value, { ...configs.get(au.value)!, inventory: undefined });

    expect(() => assertInventoryConfigured(new MarketRegistry(without))).toThrow(
      InventoryMarketConfigError,
    );
    expect(() => assertInventoryConfigured(new MarketRegistry(without))).toThrow(/AU/);
  });
});
