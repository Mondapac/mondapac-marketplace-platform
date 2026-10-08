import type { MarketContext, Population } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type {
  IdentityMarketPolicy,
  MailThrottleRules,
  SignInThrottleRules,
} from '../application/ports/identity-market-policy';
import type { PasswordRules } from '../domain/password-policy';
import type { SessionLifetime } from '../domain/session';

/**
 * The Phase 2 adapter of {@link IdentityMarketPolicy} (identity design 8.5): the `identity`
 * section of the Market's configuration, validated and frozen at boot. A Market this Region
 * Stack does not host throws (`MarketNotHostedError`); it never falls back to another Market.
 */
export class MarketConfigIdentityPolicy implements IdentityMarketPolicy {
  constructor(private readonly markets: MarketRegistry) {}

  passwordRules(market: MarketContext): PasswordRules {
    return this.markets.get(market.marketId).identity.password;
  }

  existingAccountNoticeHours(market: MarketContext): number {
    return this.markets.get(market.marketId).identity.existingAccountNoticeHours;
  }

  sessionLifetime(market: MarketContext, population: Population): SessionLifetime | null {
    const sessions: Partial<
      Record<Population, { idleTimeoutMinutes: number; absoluteLifetimeMinutes: number }>
    > = this.markets.get(market.marketId).identity.sessions;
    const lifetime = Object.hasOwn(sessions, population) ? sessions[population] : undefined;
    if (lifetime === undefined) return null;
    return {
      idleTimeoutSeconds: lifetime.idleTimeoutMinutes * 60,
      absoluteLifetimeSeconds: lifetime.absoluteLifetimeMinutes * 60,
    };
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
}
