import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { WalletPolicy, WalletSettings } from '../application/ports/wallet-policy';

/** The Market's wallet settings from Market config; none configured means unavailable. */
export class ConfigWalletPolicy implements WalletPolicy {
  constructor(private readonly markets: MarketRegistry) {}

  settings(market: MarketContext): WalletSettings | null {
    const config = this.markets.get(market.marketId);
    const wallet = config.wallet;
    if (wallet === undefined) return null;
    return {
      currency: config.defaultCurrency,
      timeZone: config.timezone,
      balanceCapMinor: BigInt(wallet.balanceCapMinor),
      promoExpiryMonths: wallet.promoExpiryMonths,
      adminIssueCapMinor: BigInt(wallet.adminIssueCapMinor),
      adminDailyCapMinor: BigInt(wallet.adminDailyCapMinor),
      adminRequestExpiryDays: wallet.adminRequestExpiryDays,
      expiringSoonDays: wallet.expiringSoonDays,
    };
  }
}
