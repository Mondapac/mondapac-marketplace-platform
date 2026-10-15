import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { NotificationsPolicy } from '../application/ports/notifications-policy';

/** The Market's notifications settings, read from its configuration. */
export class ConfigNotificationsPolicy implements NotificationsPolicy {
  constructor(private readonly markets: MarketRegistry) {}

  defaultSupportEmail(market: MarketContext): string | null {
    return this.markets.get(market.marketId).notifications?.supportEmail ?? null;
  }
}
