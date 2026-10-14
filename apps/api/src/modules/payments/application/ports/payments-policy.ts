import type { MarketContext } from '@mondapac/shared-kernel';
import type { NormalPayoutSchedule } from './connect-gateway';

export interface OnboardingUrls {
  readonly returnUrl: string;
  readonly refreshUrl: string;
}

/** The Market settings payments reads. */
export interface PaymentsPolicy {
  /** The country connected accounts are created in, or null when the Market has none set. */
  connectedAccountCountry(market: MarketContext): string | null;

  /** The seller-panel pages Stripe sends the seller back to, or null when the Market has none. */
  onboardingUrls(market: MarketContext): OnboardingUrls | null;

  /** The waiting period after a bank change in whole hours, always within 24 h to 14 d. */
  bankChangeCoolingOffHours(market: MarketContext): number;

  /** The payout schedule sellers have outside a waiting period, or null when none is set. */
  normalPayoutSchedule(market: MarketContext): NormalPayoutSchedule | null;
}

export const PAYMENTS_POLICY = Symbol('PAYMENTS_POLICY');
