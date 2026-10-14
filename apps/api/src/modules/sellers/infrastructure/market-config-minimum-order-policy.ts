import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { MinimumOrderPolicy } from '../application/ports/minimum-order-policy';
import type { MinimumOrderRule } from '../domain/minimum-order';

/**
 * {@link MinimumOrderPolicy} on the Market's configuration (design 18 decision 3): the Market
 * currency (`defaultCurrency`) and `sellers.minimumOrderMax`. A Market this Region Stack does not
 * host throws; a Market with no `sellers` section has no rule.
 */
export class MarketConfigMinimumOrderPolicy implements MinimumOrderPolicy {
  constructor(private readonly markets: MarketRegistry) {}

  rule(market: MarketContext): MinimumOrderRule | null {
    const config = this.markets.get(market.marketId);
    if (config.sellers === undefined) return null;
    return { currency: config.defaultCurrency, max: BigInt(config.sellers.minimumOrderMax) };
  }
}
