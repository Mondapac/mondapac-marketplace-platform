import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import {
  PricingNotConfiguredError,
  type PricingPolicyProvider,
} from '../application/ports/pricing-policy-provider';
import {
  createPricingPolicy,
  InvalidPricingPolicyError,
  type PricingPolicy,
} from '../domain/pricing-policy';

/** A hosted Market whose `pricing` section is missing or does not make a valid policy. */
export class PricingMarketConfigError extends Error {
  override readonly name = 'PricingMarketConfigError';
}

/**
 * Builds the policy of every hosted Market from its `pricing` section when it is constructed
 * (pricing design 4.6, 15; Ali A2), so a Region Stack with a missing or unsafe value refuses to
 * start instead of failing on a seller's first price. There is no default for a missing section.
 */
export class ConfigPricingPolicyProvider implements PricingPolicyProvider {
  private readonly policies = new Map<MarketId, PricingPolicy>();
  private readonly taxInclusive = new Map<MarketId, boolean>();

  constructor(markets: MarketRegistry) {
    const problems: string[] = [];
    for (const marketId of markets.hostedMarketIds()) {
      const config = markets.get(marketId);
      this.taxInclusive.set(marketId, config.pricesIncludeTax);
      const section = config.pricing;
      if (section === undefined) {
        problems.push(`${marketId}: no "pricing" section in config/markets/`);
        continue;
      }
      try {
        this.policies.set(
          marketId,
          createPricingPolicy({
            marketId,
            currency: config.defaultCurrency,
            maxUnitPriceMinor: BigInt(section.maxUnitPriceMinor),
            thresholdNumerator: BigInt(section.jumpThreshold.numerator),
            thresholdDenominator: BigInt(section.jumpThreshold.denominator),
            jumpDirections: section.jumpDirections,
            jumpWindow: section.jumpWindow,
          }),
        );
      } catch (error) {
        if (!(error instanceof InvalidPricingPolicyError)) throw error;
        problems.push(`${marketId}: invalid pricing policy (${error.reason.code})`);
      }
    }
    if (problems.length > 0) throw new PricingMarketConfigError(problems.join('; '));
  }

  forMarket(market: MarketContext): PricingPolicy {
    const policy = this.policies.get(market.marketId);
    if (policy === undefined) throw new PricingNotConfiguredError(market.marketId);
    return policy;
  }

  forOffer(market: MarketContext, offerId: Id<'Offer'>): PricingPolicy {
    // No Vertical override yet (design 4.6): every Offer of a Market has the Market's policy.
    void offerId;
    return this.forMarket(market);
  }

  pricesIncludeTax(market: MarketContext): boolean {
    const value = this.taxInclusive.get(market.marketId);
    if (value === undefined || !this.policies.has(market.marketId)) {
      throw new PricingNotConfiguredError(market.marketId);
    }
    return value;
  }
}
