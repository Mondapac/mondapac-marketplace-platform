import type { MarketContext, Population } from '@mondapac/shared-kernel';
import type { LinkPurpose } from '../../domain/one-time-link';
import type { PasswordRules } from '../../domain/password-policy';
import type { SessionLifetime } from '../../domain/session';
import type { ThrottleRule } from '../../domain/throttle';

/** The sign-in counters of identity design 6.8 for one Market. */
export interface SignInThrottleRules {
  readonly accountOrigin: ThrottleRule;
  readonly account: ThrottleRule;
  readonly origin: ThrottleRule;
}

/** The mail counters of identity design 6.8 for one Market. */
export interface MailThrottleRules {
  readonly account: ThrottleRule;
  readonly origin: ThrottleRule;
}

/**
 * The identity policy of a Market (identity design 8.5): one port through which `identity`
 * reads its policy values. The Phase 2 adapter reads Market configuration as code (the
 * `identity` section); the later ADR "Market settings editable by an admin" replaces the
 * adapter, not this port. A read is synchronous and never defaults a Market.
 *
 * Slice 1d reads the password rules and the notice interval; slice 2 the session lifetimes, the
 * throttles and the retention of sign-in records; slice 3 the link lifetimes, the retention of
 * unverified accounts and the mail sender; slice 5 "approval required" and the seller lifetimes.
 */
export interface IdentityMarketPolicy {
  passwordRules(market: MarketContext): PasswordRules;
  /** The least time between two "you already have an account" notices (identity 6.7). */
  existingAccountNoticeHours(market: MarketContext): number;
  /**
   * The lifetimes of a population's sessions (identity design 6.1), or null when the Market
   * configures none for it: such a population cannot open a session. `keepSignedIn` asks for the
   * "keep me signed in" lifetimes (seller side only, 14.4): null where the Market offers none.
   */
  sessionLifetime(
    market: MarketContext,
    population: Population,
    keepSignedIn?: boolean,
  ): SessionLifetime | null;
  /** Whether a new seller starts `pending` (identity design 3.3, 15; SEL-03, AC 5). */
  sellerApprovalRequired(market: MarketContext): boolean;
  signInThrottles(market: MarketContext): SignInThrottleRules;
  mailThrottles(market: MarketContext): MailThrottleRules;
  /** Sign-in records are deleted this many days after the attempt (H3). */
  signInRecordRetentionDays(market: MarketContext): number;
  /**
   * A link's lifetime from its issue (identity design 6.6; HF15: verification 24 hours), or
   * null when the Market configures none for the purpose: such a link is never issued.
   */
  linkLifetimeMinutes(market: MarketContext, purpose: LinkPurpose): number | null;
  /** A never-verified account is deleted this many days after its latest sign-up (3.1, M5: 7). */
  unverifiedAccountRetentionDays(market: MarketContext): number;
  /** The sender of the Market's mail (identity design 9). */
  mailSender(market: MarketContext): MailSender;
}

/** The `From` of a Market's mail. */
export interface MailSender {
  readonly address: string;
  readonly name: string;
}

/** Nest token of the {@link IdentityMarketPolicy}. */
export const IDENTITY_MARKET_POLICY = Symbol('IDENTITY_MARKET_POLICY');
