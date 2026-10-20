/** The assistant's own guest token (plan section 4: not the behaviour cookie, not the cart's). */
export interface GuestTokens {
  issue(): { readonly token: string; readonly hash: string };
  /** The hash of a well-formed token; null for anything else. */
  hashOf(token: string): string | null;
}

export const GUEST_TOKENS = Symbol('ASSISTANT_GUEST_TOKENS');
