import type { MarketContext, Population } from '@mondapac/shared-kernel';
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
 * throttles and the retention of sign-in records; slice 5 adds "approval required".
 */
export interface IdentityMarketPolicy {
  passwordRules(market: MarketContext): PasswordRules;
  /** The least time between two "you already have an account" notices (identity 6.7). */
  existingAccountNoticeHours(market: MarketContext): number;
  /**
   * The lifetimes of a population's sessions (identity design 6.1), or null when the Market
   * configures none for it: such a population cannot open a session.
   */
  sessionLifetime(market: MarketContext, population: Population): SessionLifetime | null;
  signInThrottles(market: MarketContext): SignInThrottleRules;
  mailThrottles(market: MarketContext): MailThrottleRules;
  /** Sign-in records are deleted this many days after the attempt (H3). */
  signInRecordRetentionDays(market: MarketContext): number;
}

/** Nest token of the {@link IdentityMarketPolicy}. */
export const IDENTITY_MARKET_POLICY = Symbol('IDENTITY_MARKET_POLICY');
