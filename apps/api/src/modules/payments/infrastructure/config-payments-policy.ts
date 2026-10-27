import { money } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { NormalPayoutSchedule } from '../application/ports/connect-gateway';
import { clampCoolingOffHours } from '../domain/payout-change';
import type {
  OnboardingUrls,
  PaymentsPolicy,
  TransferLimits,
} from '../application/ports/payments-policy';

/**
 * The onboarding pages are built in code from the Market's seller panel (the origin of the
 * seller `sign-in` link target) and a fixed path: no request input, token or id goes into either
 * URL, so there is no open redirect. A Market without a seller target has no onboarding pages.
 */
export class ConfigPaymentsPolicy implements PaymentsPolicy {
  constructor(private readonly markets: MarketRegistry) {}

  connectedAccountCountry(market: MarketContext): string | null {
    return this.markets.get(market.marketId).payments?.connectedAccountCountry ?? null;
  }

  bankChangeCoolingOffHours(market: MarketContext): number {
    return clampCoolingOffHours(
      this.markets.get(market.marketId).payments?.bankChangeCoolingOffHours,
    );
  }

  marketCurrency(market: MarketContext): string {
    return this.markets.get(market.marketId).defaultCurrency;
  }

  marketTimeZone(market: MarketContext): string {
    return this.markets.get(market.marketId).timezone;
  }

  transferLimits(market: MarketContext): TransferLimits | null {
    const payments = this.markets.get(market.marketId).payments;
    if (payments === undefined) return null;
    const max = payments.maxTransferAmount;
    const threshold = payments.dailyTransferAlertThreshold;
    return {
      maxTransferAmount: money(BigInt(max.amountMinor), max.currency),
      dailyTransferAlertThreshold: money(BigInt(threshold.amountMinor), threshold.currency),
      sendLeaseSeconds: payments.transferSendLeaseSeconds,
    };
  }

  normalPayoutSchedule(market: MarketContext): NormalPayoutSchedule | null {
    return this.markets.get(market.marketId).payments?.payoutSchedule ?? null;
  }

  onboardingUrls(market: MarketContext): OnboardingUrls | null {
    const target = this.markets.get(market.marketId).identity.links.targets.seller?.['sign-in'];
    if (target === undefined) return null;
    const origin = new URL(target).origin;
    return {
      returnUrl: `${origin}/payout-account?stripe=return`,
      refreshUrl: `${origin}/payout-account?stripe=refresh`,
    };
  }
}
