import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { IdentityMarketPolicy } from '../application/ports/identity-market-policy';
import type { PasswordRules } from '../domain/password-policy';

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
}
