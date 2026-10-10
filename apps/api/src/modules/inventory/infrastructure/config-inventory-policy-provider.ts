import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { InventoryPolicyProvider } from '../application/ports/inventory-policy-provider';

/**
 * Reads the Market's `inventory` section. The start-up check
 * (`assertInventoryConfigured`) already refused a hosted Market without it, so a missing
 * section here is a programmer error and throws: there is no default (inventory design 8).
 */
export class ConfigInventoryPolicyProvider implements InventoryPolicyProvider {
  constructor(private readonly markets: MarketRegistry) {}

  maxSourcesPerSeller(market: MarketContext): number {
    return this.section(market).maxSourcesPerSeller;
  }

  defaultLowStockThreshold(market: MarketContext): number {
    return this.section(market).defaultLowStockThreshold;
  }

  maxVariantsPerProduct(market: MarketContext): number {
    const section = this.markets.get(market.marketId).catalog;
    if (section === undefined) {
      throw new Error(`inventory: Market ${market.marketId} has no "catalog" section`);
    }
    return section.maxVariantsPerProduct;
  }

  reservationMinutes(market: MarketContext): number {
    return this.section(market).reservationMinutes;
  }

  defaultCustomerCap(market: MarketContext): number {
    return this.section(market).defaultCustomerCap;
  }

  maxLineQuantity(market: MarketContext): number {
    return this.markets.get(market.marketId).maxLineQuantity;
  }

  private section(market: MarketContext) {
    const section = this.markets.get(market.marketId).inventory;
    if (section === undefined) {
      throw new Error(`inventory: Market ${market.marketId} has no "inventory" section`);
    }
    return section;
  }
}
