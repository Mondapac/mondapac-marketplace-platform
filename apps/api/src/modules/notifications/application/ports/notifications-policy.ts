import type { MarketContext } from '@mondapac/shared-kernel';

/** The sender of the Market's mail: from the Market configuration, never from input. */
export interface MailSender {
  readonly address: string;
  readonly name: string;
}

/** The Market settings notifications reads. */
export interface NotificationsPolicy {
  /** The support address from Market configuration; null when the Market has none. */
  defaultSupportEmail(market: MarketContext): string | null;

  /** The Market's mail sender (the same one identity's mail uses). */
  mailSender(market: MarketContext): MailSender;

  /** The Market's default locale: the language of product names asked for in an order mail. */
  defaultLocale(market: MarketContext): string;

  /**
   * The storefront URL of one order for the customer's confirmation mail: the configured page
   * plus the order id as one path segment. Null when the Market configures no such page. No
   * other data goes into the URL; the page needs sign-in.
   */
  customerOrderUrl(market: MarketContext, orderId: string): string | null;

  /**
   * The two unsubscribe URLs of a marketing mail for one token: the storefront page of the link
   * in the text, and the API's one-click URL of the `List-Unsubscribe` header. Null when the
   * Market configures either one not: then it sends no marketing mail.
   */
  unsubscribeUrls(
    market: MarketContext,
    token: string,
  ): { readonly page: string; readonly oneClick: string } | null;
}

export const NOTIFICATIONS_POLICY = Symbol('NOTIFICATIONS_POLICY');
