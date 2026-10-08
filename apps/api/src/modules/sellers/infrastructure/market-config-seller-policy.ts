import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { SellerMarketPolicy } from '../application/ports/seller-market-policy';

/**
 * The slice 1 adapter of {@link SellerMarketPolicy} (sellers design 7.6, 14.1): the `sellers`
 * section of the Market's configuration, validated and frozen at boot. A Market this Region
 * Stack does not host throws (`MarketNotHostedError`); it never falls back to another Market.
 * Until the ADR-0026 store lands (slice 15) the configured value is the value; a Market with no
 * `sellers` section gets the safe value `true` (ADR-0026 decision 5), declared here in code and
 * never in `config/markets/`.
 */
export class MarketConfigSellerPolicy implements SellerMarketPolicy {
  constructor(private readonly markets: MarketRegistry) {}

  approvalRequired(market: MarketContext): boolean {
    return this.markets.get(market.marketId).sellers?.approvalRequired ?? true;
  }
}
