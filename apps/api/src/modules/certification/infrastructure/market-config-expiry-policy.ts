import type { MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { ExpiryPolicyProvider } from '../application/ports/expiry.repository';
import { assertExpiryPolicy, type ExpiryPolicy } from '../domain/expiry';

/** A hosted Market without a usable `certification` section of its configuration. */
export class CertificationMarketConfigError extends Error {
  override readonly name = 'CertificationMarketConfigError';
}

function policyOf(markets: MarketRegistry, marketId: MarketId): ExpiryPolicy | null {
  const section = markets.get(marketId).certification;
  if (section === undefined) return null;
  return {
    warningThresholdsDays: section.expiryWarningThresholdsDays,
    renewalSubmitByDays: section.renewalSubmitByDays,
  };
}

/**
 * Start-up check (certification design 5.1; Ali ruling 2026-10-17 on ADR-0003 decision 5): every
 * hosted Market has the `certification` section of `config/markets/<code>.json` and it makes a
 * usable expiry policy. The Region Stack refuses to start otherwise, so the expiry job never
 * guesses a threshold and never runs without warnings.
 */
export function assertCertificationConfigured(markets: MarketRegistry): void {
  const missing: string[] = [];
  for (const marketId of markets.hostedMarketIds()) {
    const policy = policyOf(markets, marketId);
    if (policy === null) {
      missing.push(marketId);
      continue;
    }
    try {
      assertExpiryPolicy(policy, marketId);
    } catch (error) {
      throw new CertificationMarketConfigError(
        `The "certification" section of Market ${marketId} is not usable: ${(error as Error).message}`,
      );
    }
  }
  if (missing.length > 0) {
    throw new CertificationMarketConfigError(
      `Hosted Market(s) ${missing.join(', ')} have no "certification" section in config/markets/`,
    );
  }
}

/** The expiry policy of a Market from its `certification` section (checked at start-up). */
export class MarketConfigExpiryPolicy implements ExpiryPolicyProvider {
  constructor(private readonly markets: MarketRegistry) {}

  policyFor(market: MarketContext): ExpiryPolicy {
    const policy = policyOf(this.markets, market.marketId);
    if (policy === null) {
      throw new CertificationMarketConfigError(
        `Market ${market.marketId} has no "certification" section`,
      );
    }
    return policy;
  }
}

/**
 * The Market's manufacturer-basis switch (`certification.manufacturerBasisEnabled`; cto ruling,
 * slice 14). Only an explicit `true` opens the basis; a Market without the section, an unknown
 * Market or any failure reads as off (fail closed), so `SELLER_OR_MANUFACTURER` is then read as
 * `SELLER_REQUIRED` by `ClaimRule.decide`.
 */
export function manufacturerBasisEnabledIn(markets: MarketRegistry, marketId: MarketId): boolean {
  try {
    return markets.get(marketId).certification?.manufacturerBasisEnabled === true;
  } catch {
    return false;
  }
}
