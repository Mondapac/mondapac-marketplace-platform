import { mintMarketContext } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';

// Allowed: the platform factory is the one place that mints a MarketContext.
export class MarketContextFactory {
  forMarket(marketId: string): MarketContext {
    return mintMarketContext(marketId, 'mondapac');
  }
}
