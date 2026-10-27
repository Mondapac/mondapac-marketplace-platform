import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketPayoutTermsConfig } from '../../domain/payout-terms';

/** The Market's payout terms (Market config `commissionPayouts.payoutTerms`). */
export interface PayoutTermsPolicy {
  /** Null when the Market has none: payout terms are unavailable (fail closed). */
  marketTerms(market: MarketContext): MarketPayoutTermsConfig | null;
}

export const PAYOUT_TERMS_POLICY = Symbol('PAYOUT_TERMS_POLICY');
