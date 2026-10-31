import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { PayoutPolicy, TransferLimitsView } from '../application/ports/payout-gateways';

/** The transfer limits of a Market from the payments section of its config; none means unavailable. */
export class ConfigPayoutPolicy implements PayoutPolicy {
  constructor(private readonly markets: MarketRegistry) {}

  limits(market: MarketContext): TransferLimitsView | null {
    const payments = this.markets.get(market.marketId).payments;
    if (payments === undefined) return null;
    return {
      maxTransferMinor: BigInt(payments.maxTransferAmount.amountMinor),
      dailyAlertMinor: BigInt(payments.dailyTransferAlertThreshold.amountMinor),
      currency: payments.maxTransferAmount.currency,
      sendLeaseSeconds: payments.transferSendLeaseSeconds,
    };
  }

  marketTimeZone(market: MarketContext): string {
    return this.markets.get(market.marketId).timezone;
  }
}
