import type { MarketRegistry } from '../../../platform/market-config/market-registry';

/** A hosted Market without the `catalog` section of its configuration. */
export class CatalogMarketConfigError extends Error {
  override readonly name = 'CatalogMarketConfigError';
}

/**
 * Start-up check (catalog design 7.1): every hosted Market has the `catalog` section, with no
 * default for a missing one. The Region Stack refuses to start otherwise, so no use case ever
 * has to guess a limit or a tax category for a Market.
 */
export function assertCatalogConfigured(markets: MarketRegistry): void {
  const missing = markets
    .hostedMarketIds()
    .filter((marketId) => markets.get(marketId).catalog === undefined);
  if (missing.length > 0) {
    throw new CatalogMarketConfigError(
      `Hosted Market(s) ${missing.join(', ')} have no "catalog" section in config/markets/`,
    );
  }
}
