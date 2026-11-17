import { loadServiceAreas } from '../../src/platform/market-config/service-area-config';
import type { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { ConfigOrderingPolicy } from '../../src/modules/ordering/infrastructure/config-ordering-policy';
import { TEST_MARKET_IDS, TEST_SERVICE_AREA_CONFIG_DIRS } from './test-config';

export const testAreas = loadServiceAreas(TEST_SERVICE_AREA_CONFIG_DIRS, TEST_MARKET_IDS);

/** Ordering's Market settings over the test Markets and their ServiceAreas. */
export const testOrderingPolicy = (markets: MarketRegistry): ConfigOrderingPolicy =>
  new ConfigOrderingPolicy(markets, testAreas);
