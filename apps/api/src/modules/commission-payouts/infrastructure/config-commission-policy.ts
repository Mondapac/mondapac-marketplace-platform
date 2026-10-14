import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { CommissionPolicy, CommissionSettings } from '../application/ports/commission-policy';

/** The Market's commission settings from Market config; none configured means unavailable. */
export class ConfigCommissionPolicy implements CommissionPolicy {
  constructor(private readonly markets: MarketRegistry) {}

  settings(market: MarketContext): CommissionSettings | null {
    const config = this.markets.get(market.marketId);
    const settings = config.commissionPayouts;
    if (settings === undefined) return null;
    return {
      defaultRateBps: settings.defaultRateBps,
      provisionalTaxRateBps: settings.provisionalTaxRateBps,
      currency: config.defaultCurrency,
    };
  }
}
