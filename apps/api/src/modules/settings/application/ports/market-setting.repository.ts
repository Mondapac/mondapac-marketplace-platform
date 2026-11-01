import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

export interface MarketSettingRecord {
  readonly code: string;
  readonly value: string;
  /** 1 for the first admin change, +1 for each later one. */
  readonly version: number;
  readonly updatedAt: Temporal.Instant;
  readonly updatedBy: Id<'Account'>;
}

export interface MarketSettingChange {
  readonly code: string;
  readonly value: string;
  readonly previousValue: string | null;
  readonly version: number;
  readonly changedAt: Temporal.Instant;
  readonly changedBy: Id<'Account'>;
}

/** `settings.market_settings` and its insert-only history, scoped by the Market. */
export interface MarketSettingRepository {
  list(market: MarketContext): Promise<readonly MarketSettingRecord[]>;
  find(market: MarketContext, code: string): Promise<MarketSettingRecord | null>;
  /**
   * Writes the change and its history row when the stored version is still `change.version - 1`
   * (0 means no row). Returns false when another admin changed the setting first.
   */
  apply(market: MarketContext, change: MarketSettingChange): Promise<boolean>;
}

export const MARKET_SETTING_REPOSITORY = Symbol('SETTINGS_MARKET_SETTING_REPOSITORY');
