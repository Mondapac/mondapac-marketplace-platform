import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { OrderingPolicy, ReturnUrls } from '../application/ports/ordering-policy';

/** Stripe's minimum for a Checkout session is 30 minutes. */
const SESSION_TTL_MS = 30 * 60 * 1000;
/** The cart's own limit (cart design 4; AU 50). */
const MAX_LINES = 50;

/**
 * The return pages are built in code from the Market's storefront: the origin of the customer
 * `sign-in` link target, then a fixed path and the order id. No secret, session id or token goes
 * into either URL. A Market without a customer target has no return pages: no checkout.
 */
export class ConfigOrderingPolicy implements OrderingPolicy {
  constructor(private readonly markets: MarketRegistry) {}

  returnUrls(market: MarketContext, orderId: string): ReturnUrls | null {
    const target = this.markets.get(market.marketId).identity.links.targets.customer?.['sign-in'];
    if (target === undefined) return null;
    const origin = new URL(target).origin;
    const order = encodeURIComponent(orderId);
    return {
      success: `${origin}/checkout/success?order=${order}`,
      cancel: `${origin}/checkout/cancelled?order=${order}`,
    };
  }

  sessionTtlMs(): number {
    return SESSION_TTL_MS;
  }

  maxLines(): number {
    return MAX_LINES;
  }

  refundsEnabled(market: MarketContext): boolean {
    return this.markets.get(market.marketId).tax?.refundCredit?.enabled === true;
  }

  invoicesEnabled(market: MarketContext): boolean {
    return this.markets.get(market.marketId).tax?.invoice?.enabled === true;
  }
}
