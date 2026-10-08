import type { MarketContext, Population } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type {
  IdentityMarketPolicy,
  MailSender,
  MailThrottleRules,
  SignInThrottleRules,
} from '../application/ports/identity-market-policy';
import type { LinkPage, LinkTargets } from '../application/ports/link-secrets';
import type { InvitationKind } from '../domain/invitation';
import type { LinkPurpose } from '../domain/one-time-link';
import type { PasswordRules } from '../domain/password-policy';
import type { SessionLifetime } from '../domain/session';
import type { ChallengePolicy } from '../domain/sign-in-challenge';
import type { ThrottleRule } from '../domain/throttle';
import { pendingKeys } from './pending-market-keys';

/**
 * The Phase 2 adapter of {@link IdentityMarketPolicy} (identity design 8.5): the `identity`
 * section of the Market's configuration, validated and frozen at boot. A Market this Region
 * Stack does not host throws (`MarketNotHostedError`); it never falls back to another Market.
 */
export class MarketConfigIdentityPolicy implements IdentityMarketPolicy, LinkTargets {
  constructor(private readonly markets: MarketRegistry) {}

  passwordRules(market: MarketContext): PasswordRules {
    return this.markets.get(market.marketId).identity.password;
  }

  existingAccountNoticeHours(market: MarketContext): number {
    return this.markets.get(market.marketId).identity.existingAccountNoticeHours;
  }

  sessionLifetime(
    market: MarketContext,
    population: Population,
    keepSignedIn = false,
  ): SessionLifetime | null {
    const identity = this.markets.get(market.marketId).identity;
    const sessions: Partial<
      Record<Population, { idleTimeoutMinutes: number; absoluteLifetimeMinutes: number }>
    > = keepSignedIn ? identity.keepSignedInSessions : identity.sessions;
    const lifetime = Object.hasOwn(sessions, population) ? sessions[population] : undefined;
    if (lifetime === undefined) return null;
    return {
      idleTimeoutSeconds: lifetime.idleTimeoutMinutes * 60,
      absoluteLifetimeSeconds: lifetime.absoluteLifetimeMinutes * 60,
    };
  }

  /**
   * "Approval required" lives in the `sellers` section of the Market file (sellers design 4.1;
   * moved there from `identity`, Ali 2026-10-08). A Market with no such section gets the safe
   * value `true` (ADR-0026 decision 5), never another Market's value.
   */
  sellerApprovalRequired(market: MarketContext): boolean {
    return this.markets.get(market.marketId).sellers?.approvalRequired ?? true;
  }

  signInThrottles(market: MarketContext): SignInThrottleRules {
    return this.markets.get(market.marketId).identity.signInThrottles;
  }

  mailThrottles(market: MarketContext): MailThrottleRules {
    return this.markets.get(market.marketId).identity.mailThrottles;
  }

  signInRecordRetentionDays(market: MarketContext): number {
    return this.markets.get(market.marketId).identity.signInRecordRetentionDays;
  }

  linkLifetimeMinutes(market: MarketContext, purpose: LinkPurpose): number | null {
    const lifetimes: Partial<Record<LinkPurpose, number>> = this.markets.get(market.marketId)
      .identity.links.lifetimeMinutes;
    return (Object.hasOwn(lifetimes, purpose) ? lifetimes[purpose] : undefined) ?? null;
  }

  unverifiedAccountRetentionDays(market: MarketContext): number {
    return this.markets.get(market.marketId).identity.unverifiedAccountRetentionDays;
  }

  mailSender(market: MarketContext): MailSender {
    const { fromAddress, fromName } = this.markets.get(market.marketId).identity.mail;
    return { address: fromAddress, name: fromName };
  }

  invitationLifetimeMinutes(market: MarketContext, kind: InvitationKind): number | null {
    return pendingKeys(this.identityOf(market)).invitationLifetimeMinutes(kind);
  }

  challengePolicy(market: MarketContext): ChallengePolicy | null {
    return pendingKeys(this.identityOf(market)).challengePolicy();
  }

  secondFactorThrottle(market: MarketContext): ThrottleRule | null {
    return pendingKeys(this.identityOf(market)).secondFactorThrottle();
  }

  private identityOf(market: MarketContext): unknown {
    return this.markets.get(market.marketId).identity;
  }

  /** `LinkTargets` (identity design 9): the page per population and page, or null. */
  target<P extends Population>(
    market: MarketContext,
    population: P,
    page: LinkPage<P>,
  ): string | null {
    // Each population has its own pages in the Market file (the admin panel's differ).
    const targets: Partial<Record<Population, Partial<Record<string, string>>>> = this.markets.get(
      market.marketId,
    ).identity.links.targets;
    const pages = Object.hasOwn(targets, population) ? targets[population] : undefined;
    if (pages === undefined) return null;
    return (Object.hasOwn(pages, page) ? pages[page] : undefined) ?? null;
  }
}
