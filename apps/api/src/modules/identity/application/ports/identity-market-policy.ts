import type { MarketContext, Population } from '@mondapac/shared-kernel';
import type { InvitationKind } from '../../domain/invitation';
import type { LinkPurpose } from '../../domain/one-time-link';
import type { ChallengePolicy } from '../../domain/sign-in-challenge';
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

  // Slice 7b. These values come from Market configuration keys that the Market-config PR adds
  // (identity design 6.7, the 7a note "Needed for 7b"); this branch edits no config file. Until
  // a Market configures them, each read answers null and the flow that needs it fails closed
  // (`access.unavailable`, or the operator routine refuses). The admin session lifetime is
  // `sessionLifetime(market, 'admin')`, the enrolment link's `linkLifetimeMinutes(market,
  // 'enrol-second-factor')`, and the admin pages `LinkTargets.target(market, 'admin', page)`.

  /**
   * An invitation's lifetime from its dispatch, by kind (identity design 3.4, 6.6; HF15: admin
   * 72 hours, otherwise 7 days); also the cut-off after which a never-dispatched pending
   * invitation is replaced or purged (item G). Null: not configured for this kind.
   */
  invitationLifetimeMinutes(market: MarketContext, kind: InvitationKind): number | null;

  /** The challenge policy (identity design 2.1, 6.8: 5 attempts, 5 minutes), or null. */
  challengePolicy(market: MarketContext): ChallengePolicy | null;

  /**
   * The `second-factor.account` counter (identity design 6.8, HF2: 10 failed codes or recovery
   * codes in 24 hours, then the factor step is refused for 24 hours), or null. Nothing lifts its
   * block early (Ali 2026-10-08, Hassan I-4).
   */
  secondFactorThrottle(market: MarketContext): ThrottleRule | null;

  /**
   * Slice 9: how many re-applications a rejected seller may make since its last approval
   * (identity design 3.3: "fewer than 3", a Market policy value), or null. No Market
   * configuration key exists yet (it needs a Market-config PR), so the adapter answers null and
   * re-apply fails closed (`access.unavailable`) until a Market configures it.
   */
  sellerReapplyLimit(market: MarketContext): number | null;

  /**
   * Slice 10 (identity design 2.3): the most custom roles one owner may hold in a scope: per
   * seller in seller scope (proposal: 20), per Market in platform scope (proposal: 50), or null
   * when the Market configures none, so the role editor's create fails closed
   * (`access.unavailable`). No Market configuration key exists yet (a Market-config PR adds it).
   */
  customRoleLimit(market: MarketContext, scope: 'platform' | 'seller'): number | null;
}

/** The `From` of a Market's mail. */
export interface MailSender {
  readonly address: string;
  readonly name: string;
}

/** Nest token of the {@link IdentityMarketPolicy}. */
export const IDENTITY_MARKET_POLICY = Symbol('IDENTITY_MARKET_POLICY');
