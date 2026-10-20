import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { SearchPolicy, SearchSettings } from '../application/ports/search-policy';

/** The language-neutral PostgreSQL configuration, used when a Market names none. */
export const DEFAULT_TEXT_SEARCH_CONFIG = 'simple';

/** The Market's search settings, read from its configuration. */
export class ConfigSearchPolicy implements SearchPolicy {
  constructor(private readonly markets: MarketRegistry) {}

  settings(market: MarketContext): SearchSettings {
    const config = this.markets.get(market.marketId);
    return {
      textSearchConfig: config.search?.textSearchConfig ?? DEFAULT_TEXT_SEARCH_CONFIG,
      locale: config.defaultLocale,
      currency: config.defaultCurrency,
    };
  }
}
