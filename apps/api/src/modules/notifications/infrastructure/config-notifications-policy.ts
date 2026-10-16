import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { MailSender, NotificationsPolicy } from '../application/ports/notifications-policy';

/** The Market's notifications settings, read from its configuration. */
export class ConfigNotificationsPolicy implements NotificationsPolicy {
  constructor(private readonly markets: MarketRegistry) {}

  defaultSupportEmail(market: MarketContext): string | null {
    return this.markets.get(market.marketId).notifications?.supportEmail ?? null;
  }

  mailSender(market: MarketContext): MailSender {
    const { fromAddress, fromName } = this.markets.get(market.marketId).identity.mail;
    return { address: fromAddress, name: fromName };
  }

  defaultLocale(market: MarketContext): string {
    return this.markets.get(market.marketId).defaultLocale;
  }

  smsSenderId(market: MarketContext): string | null {
    return this.markets.get(market.marketId).notifications?.sms?.senderId ?? null;
  }

  customerOrderUrl(market: MarketContext, orderId: string): string | null {
    const page = this.markets.get(market.marketId).notifications?.customerOrderPage;
    return page === undefined ? null : `${page.replace(/\/+$/, '')}/${encodeURIComponent(orderId)}`;
  }
}
