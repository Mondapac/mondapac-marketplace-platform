import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketConfig } from '../../../platform/market-config/market-config';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import {
  CatalogNotConfiguredError,
  type CatalogMarketPolicy,
} from '../application/ports/catalog-market-policy';
import type { SensitiveChangesPolicy } from '../domain/product-revision-policy';

type CatalogSection = NonNullable<MarketConfig['catalog']>;

/** Reads the `catalog` section of the Market file (catalog design 7.1) through the registry. */
export class ConfigCatalogMarketPolicy implements CatalogMarketPolicy {
  constructor(private readonly markets: MarketRegistry) {}

  taxCategoryCodes(market: MarketContext): readonly string[] {
    return this.section(market).taxCategories.map((category) => category.code);
  }

  sensitiveChanges(market: MarketContext): SensitiveChangesPolicy {
    return { ...this.section(market).sensitiveChanges };
  }

  locales(market: MarketContext): {
    readonly default: string;
    readonly supported: readonly string[];
  } {
    // The locales belong to the Market, not to the catalog section; a missing section is still
    // a configuration fault (the same answer as the other settings).
    this.section(market);
    const config = this.markets.get(market.marketId);
    return { default: config.defaultLocale, supported: [...config.supportedLocales] };
  }

  maxVariantsPerProduct(market: MarketContext): number {
    return this.section(market).maxVariantsPerProduct;
  }

  productTypes(market: MarketContext): readonly string[] {
    return [...this.section(market).productTypes];
  }

  defaultFamily(market: MarketContext): string {
    return this.section(market).defaultFamily;
  }

  approvalRequired(market: MarketContext): Promise<boolean> {
    // The port is async for the store of slice 10: a fault comes back as a rejection too.
    try {
      return Promise.resolve(this.section(market).approvalRequired);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private section(market: MarketContext): CatalogSection {
    const catalog = this.markets.get(market.marketId).catalog;
    if (catalog === undefined) throw new CatalogNotConfiguredError(market.marketId);
    return catalog;
  }
}
