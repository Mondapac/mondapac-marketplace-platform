import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type {
  StoreProfileLocales,
  StoreProfileLocalesPolicy,
} from '../application/ports/store-profile-locales';

/**
 * {@link StoreProfileLocalesPolicy} on the Market's configuration (`defaultLocale`,
 * `supportedLocales`). A Market this Region Stack does not host throws.
 */
export class MarketConfigStoreProfileLocales implements StoreProfileLocalesPolicy {
  constructor(private readonly markets: MarketRegistry) {}

  locales(market: MarketContext): StoreProfileLocales {
    const config = this.markets.get(market.marketId);
    return { defaultLocale: config.defaultLocale, supportedLocales: config.supportedLocales };
  }
}
