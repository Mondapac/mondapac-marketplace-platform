import type { MarketContext, Population } from '@mondapac/shared-kernel';

/** A newly minted link token and the hash that is stored (identity design 6.6). */
export interface IssuedLinkToken {
  /** The secret: only in the mail's link fragment; never stored, logged, or put in an event. */
  readonly token: string;
  readonly tokenHash: Uint8Array;
}

/**
 * Link tokens (identity design 6.6): the token shape and storage of sessions (6.2) with a prefix
 * of their own, so a session token is never taken for a link token or the other way round.
 */
export interface LinkTokens {
  issue(): IssuedLinkToken;
  /** The stored hash of a presented token, or null when it does not have the token's shape. */
  hashOf(token: string): Uint8Array | null;
}

/** Nest token of the {@link LinkTokens}. */
export const LINK_TOKENS = Symbol('LINK_TOKENS');

/**
 * The panel pages a mail of `identity` links to, per population (slice 4 adds the reset page;
 * R-3 the admin review queue, identity design 8.7). Each population has its own pages, as in the
 * Market file: `seller-review-queue` exists only for `admin`.
 */
export interface LinkPages {
  readonly customer: 'verify-email' | 'sign-in' | 'reset-password';
  /**
   * Slice 9 adds the seller panel's invitation acceptance page (E9); until the Market-config PR
   * configures it, it answers null and no seller invitation is issued.
   */
  readonly seller: 'verify-email' | 'sign-in' | 'reset-password' | 'accept-invitation';
  /**
   * Slice 7b adds the admin panel's sign-in, invitation acceptance, enrolment and reset pages;
   * until the Market-config PR configures them they answer null and no such mail is sent.
   */
  readonly admin:
    | 'seller-review-queue'
    | 'sign-in'
    | 'accept-invitation'
    | 'enrol-second-factor'
    | 'reset-password';
}

/** A page of {@link LinkPages}: of one population, or of any when none is named. */
export type LinkPage<P extends Population = Population> = LinkPages[P];

/**
 * Where a mail's link points (identity design 9, `LinkTargets(market, population, purpose)`):
 * configuration, because the panel and storefront hosts are not decided (brief s6; D2). The
 * answer is an absolute URL without a fragment; the token, when there is one, goes into the
 * fragment, never the path or the query (I15). Null when the Market configures no page for this
 * population, including a page of another population: the mail cannot be sent.
 */
export interface LinkTargets {
  target<P extends Population>(
    market: MarketContext,
    population: P,
    page: LinkPage<P>,
  ): string | null;
}

/** Nest token of the {@link LinkTargets}. */
export const LINK_TARGETS = Symbol('LINK_TARGETS');
