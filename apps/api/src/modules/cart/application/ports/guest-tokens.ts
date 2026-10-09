/** The guest token (cart design 4): 32 random bytes, base64url, stored only as a SHA-256 hash. */
export interface GuestTokens {
  /** A new token and its hash (lowercase hex). The raw token goes only into `Set-Cookie`. */
  issue(): { readonly token: string; readonly hash: string };
  /** The hash of a token from a cookie, or null when the value is not a well-formed token. */
  hashOf(token: string): string | null;
}

export const GUEST_TOKENS = Symbol('GUEST_TOKENS');
