import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { WalletStatus, WalletStatusReason } from '../../domain/wallet-status';

export interface MarketSettingRecord {
  readonly status: WalletStatus;
  readonly reason: WalletStatusReason | null;
  readonly updatedAt: Temporal.Instant;
  readonly updatedBy: Id<'Account'>;
  /** Starts at 1 with the first real change; the seeded or missing row reads as 0 (no record). */
  readonly version: number;
}

/** The runtime switch of the wallet (`wallet.market_settings`): one row per Market, none means `off`. */
export interface MarketSettingRepository {
  find(market: MarketContext): Promise<MarketSettingRecord | null>;
  /** Locks the row until the unit ends (a no-change update) and returns it. */
  findForUpdate(market: MarketContext): Promise<MarketSettingRecord | null>;
  save(market: MarketContext, record: MarketSettingRecord): Promise<void>;
}

export const MARKET_SETTING_REPOSITORY = Symbol('MARKET_SETTING_REPOSITORY');
