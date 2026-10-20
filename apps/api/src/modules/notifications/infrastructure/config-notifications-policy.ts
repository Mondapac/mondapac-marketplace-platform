import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type {
  CartReminderSettings,
  MailSender,
  NotificationsPolicy,
} from '../application/ports/notifications-policy';

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

  customerOrderUrl(market: MarketContext, orderId: string): string | null {
    const page = this.markets.get(market.marketId).notifications?.customerOrderPage;
    return page === undefined ? null : `${page.replace(/\/+$/, '')}/${encodeURIComponent(orderId)}`;
  }

  unsubscribeUrls(market: MarketContext, token: string) {
    const settings = this.markets.get(market.marketId).notifications;
    const page = settings?.unsubscribePage;
    const oneClick = settings?.oneClickUnsubscribeUrl;
    if (page === undefined || oneClick === undefined) return null;
    const withToken = (url: string): string => {
      const built = new URL(url);
      built.searchParams.set('token', token);
      return built.toString();
    };
    return { page: withToken(page), oneClick: withToken(oneClick) };
  }

  cartReminders(market: MarketContext): CartReminderSettings | null {
    const settings = this.markets.get(market.marketId).notifications?.cartReminders;
    if (settings === undefined) return null;
    return {
      mode: settings.mode,
      cartPage: settings.cartPage,
      testAccountIds: settings.testAccountIds ?? [],
    };
  }
}
