import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { CartPolicy } from '../application/ports/cart-policy';
import type { CartLimits } from '../domain/cart';

/** The most lines one cart holds (cart design 4; AU 50). A constant until a Market needs another. */
const MAX_LINES = 50;
const GUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The line ceiling is the Market's `maxLineQuantity`; there is no default. */
export class ConfigCartPolicy implements CartPolicy {
  constructor(private readonly markets: MarketRegistry) {}

  limits(market: MarketContext): CartLimits {
    return {
      maxLineQuantity: this.markets.get(market.marketId).maxLineQuantity,
      maxLines: MAX_LINES,
    };
  }

  guestTtlMs(): number {
    return GUEST_TTL_MS;
  }
}
