import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { TaxPolicy, TaxSettings } from '../application/ports/tax-policy';

/** The Market's tax settings from Market config; none configured means unavailable. */
export class ConfigTaxPolicy implements TaxPolicy {
  constructor(private readonly markets: MarketRegistry) {}

  settings(market: MarketContext): TaxSettings | null {
    const config = this.markets.get(market.marketId);
    if (config.tax === undefined) return null;
    return {
      defaultRateBps: config.tax.defaultRateBps,
      categoryCodes: (config.catalog?.taxCategories ?? []).map((category) => category.code),
    };
  }
}
