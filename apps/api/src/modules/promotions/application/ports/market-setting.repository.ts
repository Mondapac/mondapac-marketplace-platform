import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PromotionsStatus } from '../../domain/market-status';

export interface MarketSettingRecord {
  readonly status: PromotionsStatus;
  readonly updatedAt: Temporal.Instant;
  readonly updatedBy: Id<'Account'>;
}

/** The runtime switch of promotions (`promotions.market_settings`): one row per Market, none means `off`. */
export interface MarketSettingRepository {
  find(market: MarketContext): Promise<MarketSettingRecord | null>;
  /** Inserts the Market's row, or changes it; two first writes cannot collide. */
  save(market: MarketContext, record: MarketSettingRecord): Promise<void>;
}

export const MARKET_SETTING_REPOSITORY = Symbol('PROMOTIONS_MARKET_SETTING_REPOSITORY');
