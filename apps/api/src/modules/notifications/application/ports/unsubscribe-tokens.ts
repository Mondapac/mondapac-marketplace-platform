import type { Id, MarketContext } from '@mondapac/shared-kernel';

/**
 * The signed token of a marketing mail's unsubscribe link (personalization package 1b). It names
 * one customer account and is bound to the Market; it needs no expiry, because it can only
 * withdraw consent and the Spam Act asks the link to keep working. The token never reaches a log,
 * an event or an error.
 */
export interface UnsubscribeTokens {
  /** A URL-safe token for this account in this Market. */
  issue(market: MarketContext, accountId: Id<'Account'>): string;

  /** The account a token names, or null when it is malformed, forged or of another Market. */
  verify(market: MarketContext, token: unknown): Id<'Account'> | null;
}

export const UNSUBSCRIBE_TOKENS = Symbol('UNSUBSCRIBE_TOKENS');

/** The notifications stack secret (32 bytes) the token key is derived from. */
export const NOTIFICATIONS_SECRET = Symbol('NOTIFICATIONS_SECRET');
