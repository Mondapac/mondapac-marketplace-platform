import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { PayoutTermsPolicy } from '../application/ports/payout-terms-policy';
import type { MarketPayoutTermsConfig } from '../domain/payout-terms';

/** The Market's payout terms from Market config; none configured means unavailable. */
export class ConfigPayoutTermsPolicy implements PayoutTermsPolicy {
  constructor(private readonly markets: MarketRegistry) {}

  marketTerms(market: MarketContext): MarketPayoutTermsConfig | null {
    const terms = this.markets.get(market.marketId).commissionPayouts?.payoutTerms;
    return terms === undefined ? null : terms;
  }
}
