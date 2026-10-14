import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { ShippingPolicy } from '../application/ports/shipping-policy';

/** The Market's settings for shipping: the flat fee is in the Market's default currency. */
export class ConfigShippingPolicy implements ShippingPolicy {
  constructor(private readonly markets: MarketRegistry) {}

  currency(market: MarketContext): string {
    return this.markets.get(market.marketId).defaultCurrency;
  }
}
