import type { MarketContext } from '@mondapac/shared-kernel';

export interface ReturnUrls {
  readonly success: string;
  readonly cancel: string;
}

/** The Market settings ordering reads. */
export interface OrderingPolicy {
  /** The storefront pages Stripe sends the customer back to, or null when the Market has none. */
  returnUrls(market: MarketContext, orderId: string): ReturnUrls | null;
  /** How long the hosted payment page stays open, in milliseconds (Stripe's minimum is 30 min). */
  sessionTtlMs(): number;
  /** The most lines one order takes (the cart's own limit). */
  maxLines(): number;
}

export const ORDERING_POLICY = Symbol('ORDERING_POLICY');
