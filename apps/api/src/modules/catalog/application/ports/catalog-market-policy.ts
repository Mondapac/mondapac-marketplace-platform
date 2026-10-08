import type { MarketContext } from '@mondapac/shared-kernel';
import type { SensitiveChangesPolicy } from '../../domain/product-revision-policy';

export const CATALOG_MARKET_POLICY = Symbol('CATALOG_MARKET_POLICY');

/**
 * What the catalog reads from the Market's `catalog` configuration (catalog design 7.1, 7.3): the
 * only way application code reaches these settings, so slice 10 swaps `approvalRequired` for the
 * ADR-0026 store without touching a caller. Every method takes the `MarketContext` (no default
 * Market) and answers for that Market alone. A Market without a `catalog` section is a
 * configuration fault: the methods throw `CatalogNotConfiguredError`, never a permissive value.
 */
export interface CatalogMarketPolicy {
  /** The tax category codes a product may carry, in the order configured. */
  taxCategoryCodes(market: MarketContext): readonly string[];
  /** Which changes to a published product go to review (4.3). */
  sensitiveChanges(market: MarketContext): SensitiveChangesPolicy;
  /** The Market's default locale and the locales content may be written in. */
  locales(market: MarketContext): {
    readonly default: string;
    readonly supported: readonly string[];
  };
  /** The most non-retired variants one product may hold (2.1). */
  maxVariantsPerProduct(market: MarketContext): number;
  /** Whether a new revision waits for review (4.2 row 1); read in the submitting unit. */
  approvalRequired(market: MarketContext): Promise<boolean>;
}

export class CatalogNotConfiguredError extends Error {
  constructor(readonly marketId: string) {
    super(`Market "${marketId}" has no catalog configuration`);
    this.name = 'CatalogNotConfiguredError';
  }
}
