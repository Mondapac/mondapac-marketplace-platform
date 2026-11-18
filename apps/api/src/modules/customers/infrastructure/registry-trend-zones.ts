import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { TrendZones } from '../application/ports/seller-customers.repository';

/**
 * {@link TrendZones} from the Market's configured zone. A seller has no zone of its own in code yet
 * (`sellers` keeps the region's default), so the Market's zone is the fallback ADR-0005 allows.
 */
export class RegistryTrendZones implements TrendZones {
  constructor(private readonly markets: MarketRegistry) {}

  zoneOf(market: MarketContext): string {
    return this.markets.get(market.marketId).timezone;
  }
}
