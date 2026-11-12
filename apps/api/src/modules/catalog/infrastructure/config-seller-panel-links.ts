import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { SellerPanelLinks } from '../application/ports/seller-panel-links';

/**
 * The seller panel's Products page. The approved text links it "filtered to Missing details"; the
 * filter joins this path once the panel reads one (A4-4 open question).
 */
const PRODUCTS_PATH = '/products';

/**
 * {@link SellerPanelLinks} from the Market's configuration: the seller panel's origin is the one
 * of identity's seller sign-in link (`identity.links.targets.seller.sign-in`), as ordering builds
 * its storefront links from the customer one. No default Market and no default address.
 */
export class ConfigSellerPanelLinks implements SellerPanelLinks {
  constructor(private readonly markets: MarketRegistry) {}

  productsUrl(market: MarketContext): string | null {
    const target = this.markets.get(market.marketId).identity.links.targets.seller?.['sign-in'];
    if (target === undefined) return null;
    return `${new URL(target).origin}${PRODUCTS_PATH}`;
  }
}
