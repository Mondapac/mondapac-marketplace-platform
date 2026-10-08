import type { MarketContext } from '@mondapac/shared-kernel';

/** The Market settings inventory reads (inventory design 8; data design 8.3). */
export interface InventoryPolicyProvider {
  /** The most sources one seller may have in the Market, the Default included (AU 4). */
  maxSourcesPerSeller(market: MarketContext): number;

  /** The low-stock threshold of a seller who set none, 0 to 99 (AU 10; design 5.2). */
  defaultLowStockThreshold(market: MarketContext): number;
}

export const INVENTORY_POLICY_PROVIDER = Symbol('INVENTORY_POLICY_PROVIDER');
