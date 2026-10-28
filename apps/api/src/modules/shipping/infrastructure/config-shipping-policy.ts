import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { ServiceAreaDirectory } from '../../../platform/market-config/service-area-directory';
import type { ShippingPolicy } from '../application/ports/shipping-policy';

/**
 * The Market's settings for shipping: the flat fee is in the Market's default currency, and the
 * delivery area is the ServiceAreas open for delivery.
 */
export class ConfigShippingPolicy implements ShippingPolicy {
  constructor(
    private readonly markets: MarketRegistry,
    private readonly areas: ServiceAreaDirectory,
  ) {}

  currency(market: MarketContext): string {
    return this.markets.get(market.marketId).defaultCurrency;
  }

  timeZone(market: MarketContext): string {
    return this.markets.get(market.marketId).timezone;
  }

  deliversTo(market: MarketContext, postcode: string): boolean {
    return this.areas.areaFor(market.marketId, postcode)?.deliveryEnabled === true;
  }
}
