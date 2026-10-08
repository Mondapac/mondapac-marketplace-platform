import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PricingPolicy } from '../../domain/pricing-policy';

export const PRICING_POLICY_PROVIDER = Symbol('PRICING_POLICY_PROVIDER');

/**
 * Where pricing gets its policy (pricing design 4.6): the Market's today; a Vertical override
 * plugs in here later (`forOffer`) without changing a caller. Every call names the Market (no
 * default Market). A Market without a policy is a configuration fault: it throws
 * `PricingNotConfiguredError`, never a permissive value.
 */
export interface PricingPolicyProvider {
  forMarket(market: MarketContext): PricingPolicy;

  /**
   * The policy that measures a write to `offerId` (design 4.6): the Market's today; a Vertical
   * override answers here once catalog exposes an Offer's vertical. Use cases call this one.
   *
   * Today the answer is the Market's policy and ignores `offerId`, so a caller may ask before
   * ownership is checked. Any future `forOffer` or Vertical override must be applied only after
   * the ownership check, using the vertical taken from catalog's answer for the owned Offer, and
   * must never be keyed on the input id: a caller-supplied id must not choose a looser policy
   * (Hassan, part 3b review L1). The change that adds the override moves the call after
   * ownership in every use case and changes this signature to take catalog's answer.
   */
  forOffer(market: MarketContext, offerId: Id<'Offer'>): PricingPolicy;

  /**
   * The Market's price convention (`MarketConfig.pricesIncludeTax`, design 4.5; Ali A2), stored
   * on each record as `taxInclusive` when it is written. No default.
   */
  pricesIncludeTax(market: MarketContext): boolean;
}

export class PricingNotConfiguredError extends Error {
  override readonly name = 'PricingNotConfiguredError';
  constructor(readonly marketId: string) {
    super(`Market "${marketId}" has no pricing policy`);
  }
}
