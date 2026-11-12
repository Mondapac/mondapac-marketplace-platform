import type { MarketContext } from '@mondapac/shared-kernel';

/** Links into the seller panel that catalog's seller emails carry, from the Market's configuration. */
export interface SellerPanelLinks {
  /** The panel's Products page; null when the Market configures no seller panel address. */
  productsUrl(market: MarketContext): string | null;
}

export const SELLER_PANEL_LINKS = Symbol('CATALOG_SELLER_PANEL_LINKS');
