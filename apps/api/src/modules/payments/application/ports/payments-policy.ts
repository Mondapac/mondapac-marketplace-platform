import type { MarketContext } from '@mondapac/shared-kernel';

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
}

export const PAYMENTS_POLICY = Symbol('PAYMENTS_POLICY');
