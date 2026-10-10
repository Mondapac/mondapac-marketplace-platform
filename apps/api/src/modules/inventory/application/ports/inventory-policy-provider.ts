import type { MarketContext } from '@mondapac/shared-kernel';

/** The Market settings inventory reads (inventory design 8; data design 8.3). */
export interface InventoryPolicyProvider {
  /** The most sources one seller may have in the Market, the Default included (AU 4). */
  maxSourcesPerSeller(market: MarketContext): number;

  /** The low-stock threshold of a seller who set none, 0 to 99 (AU 10; design 5.2). */
  defaultLowStockThreshold(market: MarketContext): number;

  /**
   * The most variants one product may hold (catalog `maxVariantsPerProduct`, AU 100): it bounds the
   * `offer-moved` mapping and so the re-key's lock set (design 3.6 step 2).
   */
  maxVariantsPerProduct(market: MarketContext): number;

  /** How long a checkout reservation holds stock, in minutes (AU 15; design 4.2, 8). */
  reservationMinutes(market: MarketContext): number;

  /** The per-customer cap `D` of a line whose Offer sets no limit (AU 10; design 5.1). */
  defaultCustomerCap(market: MarketContext): number;

  /** The Market's line ceiling, `MarketConfig.maxLineQuantity` (AU 99): no cap exceeds it. */
  maxLineQuantity(market: MarketContext): number;
}

export const INVENTORY_POLICY_PROVIDER = Symbol('INVENTORY_POLICY_PROVIDER');
