import type { MarketRegistry } from '../../../platform/market-config/market-registry';

/** A hosted Market without the `inventory` section of its configuration. */
export class InventoryMarketConfigError extends Error {
  override readonly name = 'InventoryMarketConfigError';
}

/**
 * Start-up check (inventory design 8): every hosted Market has the `inventory` section, with no
 * default for a missing one. The Region Stack refuses to start otherwise, so no use case ever
 * has to guess a limit for a Market.
 */
export function assertInventoryConfigured(markets: MarketRegistry): void {
  const missing = markets
    .hostedMarketIds()
    .filter((marketId) => markets.get(marketId).inventory === undefined);
  if (missing.length > 0) {
    throw new InventoryMarketConfigError(
      `Hosted Market(s) ${missing.join(', ')} have no "inventory" section in config/markets/`,
    );
  }
}
