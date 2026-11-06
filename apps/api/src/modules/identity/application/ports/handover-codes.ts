import type { Id, MarketContext } from '@mondapac/shared-kernel';

/**
 * The handover codes of agent invitations (ADR-0045 decision 2). A code is made once, shown to
 * the issuing admin once and never stored: only {@link hmacOf} is kept, on the invitation it is
 * bound to, so a code cannot be moved to another invitation or Market.
 */
export interface HandoverCodes {
  /** A new code (at least 40 random bits, base32) in the form shown to the admin. */
  issue(): string;

  /**
   * The HMAC-SHA-256 of a normalised code (ten upper-case characters, `normaliseHandoverCode`)
   * under a key of its own, over the Market and the invitation.
   */
  hmacOf(market: MarketContext, invitationId: Id<'Invitation'>, normalisedCode: string): Uint8Array;

  /** Whether `stored` is the HMAC of this code for this invitation, in constant time. */
  matches(
    market: MarketContext,
    invitationId: Id<'Invitation'>,
    normalisedCode: string,
    stored: Uint8Array,
  ): boolean;
}

/** Nest token of the {@link HandoverCodes}. */
export const HANDOVER_CODES = Symbol('HANDOVER_CODES');
