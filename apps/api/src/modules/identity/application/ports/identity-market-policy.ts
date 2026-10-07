import type { MarketContext } from '@mondapac/shared-kernel';
import type { PasswordRules } from '../../domain/password-policy';

/**
 * The identity policy of a Market (identity design 8.5): one port through which `identity`
 * reads its policy values. The Phase 2 adapter reads Market configuration as code (the
 * `identity` section); the later ADR "Market settings editable by an admin" replaces the
 * adapter, not this port. A read is synchronous and never defaults a Market.
 *
 * Slice 1d reads the password rules; slice 5 adds "approval required", later slices lifetimes
 * and limits.
 */
export interface IdentityMarketPolicy {
  passwordRules(market: MarketContext): PasswordRules;
}

/** Nest token of the {@link IdentityMarketPolicy}. */
export const IDENTITY_MARKET_POLICY = Symbol('IDENTITY_MARKET_POLICY');
