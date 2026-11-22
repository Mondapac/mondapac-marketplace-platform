import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { MarketZone } from '../application/ports/market-zone';

/** {@link MarketZone} from the Market's configured time zone and default currency. */
export class RegistryMarketZone implements MarketZone {
  constructor(private readonly markets: MarketRegistry) {}

  zoneOf(market: MarketContext): string {
    return this.markets.get(market.marketId).timezone;
  }

  currencyOf(market: MarketContext): string {
    return this.markets.get(market.marketId).defaultCurrency;
  }
}
