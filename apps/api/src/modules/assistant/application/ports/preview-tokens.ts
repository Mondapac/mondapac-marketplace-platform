import type { MarketContext, Temporal } from '@mondapac/shared-kernel';

/** A preview token stays valid this long; the admin takes a new one after it. */
export const PREVIEW_TOKEN_TTL_MINUTES = 30;

/**
 * The assistant's internal preview (conversation.md "Preview for internal"): a short-lived token
 * an admin with `assistant.settings.manage` takes to the storefront, so the assistant answers that
 * browser while the audience is `internal`. Signed by the server, bound to one Market, never
 * stored. Off (no key configured): nothing is issued and nothing verifies.
 */
export interface PreviewTokens {
  /** Whether a signing key is configured. */
  available(): boolean;
  /** A new token valid until `expiresAt`; null when no key is configured. */
  issue(
    market: MarketContext,
    now: Temporal.Instant,
  ): { readonly token: string; readonly expiresAt: Temporal.Instant } | null;
  /** True only for an unexpired token this server signed for this Market. Never throws. */
  verify(market: MarketContext, token: unknown, now: Temporal.Instant): boolean;
}

export const PREVIEW_TOKENS = Symbol('ASSISTANT_PREVIEW_TOKENS');
