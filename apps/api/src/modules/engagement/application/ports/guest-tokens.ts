/**
 * The engagement guest token: 32 random bytes, base64url, in its own cookie (not the cart's), and
 * stored only as a SHA-256 hash. It lives 30 days, as long as a guest's behaviour is kept.
 */
export interface EngagementGuestTokens {
  /** A new token and its hash (lowercase hex). The raw token goes only into `Set-Cookie`. */
  issue(): { readonly token: string; readonly hash: string };
  /** The hash of a token from a cookie, or null when the value is not a well-formed token. */
  hashOf(token: string): string | null;
}

export const ENGAGEMENT_GUEST_TOKENS = Symbol('ENGAGEMENT_GUEST_TOKENS');
