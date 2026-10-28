import type { MarketContext, Money } from '@mondapac/shared-kernel';
import type { NormalPayoutSchedule } from './connect-gateway';

export interface OnboardingUrls {
  readonly returnUrl: string;
  readonly refreshUrl: string;
}

/** The Market's settings for sending transfers to sellers (package 6c); none has a core default. */
export interface TransferLimits {
  /** The most one transfer may be, in the Market's currency (HP-9). */
  readonly maxTransferAmount: Money;
  /** The day's executed total above which payments raises an alert. */
  readonly dailyTransferAlertThreshold: Money;
  /** How long a send is in flight before a lookup may decide it was not made. */
  readonly sendLeaseSeconds: number;
}

/** The Market settings payments reads. */
export interface PaymentsPolicy {
  /** The country connected accounts are created in, or null when the Market has none set. */
  connectedAccountCountry(market: MarketContext): string | null;

  /** The seller-panel pages Stripe sends the seller back to, or null when the Market has none. */
  onboardingUrls(market: MarketContext): OnboardingUrls | null;

  /** The waiting period after a bank change in whole hours, always within 24 h to 14 d. */
  bankChangeCoolingOffHours(market: MarketContext): number;

  /** The Market's currency (upper-case ISO 4217): the only one a transfer may be made in. */
  marketCurrency(market: MarketContext): string;

  /** The Market's IANA time zone, the fallback for "the day" of the daily transfer total. */
  marketTimeZone(market: MarketContext): string;

  /** The transfer settings, or null when the Market has none (transfers are then unavailable). */
  transferLimits(market: MarketContext): TransferLimits | null;

  /** The payout schedule sellers have outside a waiting period, or null when none is set. */
  normalPayoutSchedule(market: MarketContext): NormalPayoutSchedule | null;
}

export const PAYMENTS_POLICY = Symbol('PAYMENTS_POLICY');
