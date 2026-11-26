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
  /** The admin's reason (1 to 500 characters, trimmed), kept on the history row; null: none. */
  readonly note: string | null;
}

/** One row of a setting's insert-only history (G4d3): the change that made `version`. */
export interface MarketSettingHistoryRecord {
  readonly code: string;
  readonly version: number;
  /** The value before this change; null when the default was in force. */
  readonly previousValue: string | null;
  readonly value: string;
  readonly changedAt: Temporal.Instant;
  readonly changedBy: Id<'Account'>;
  readonly note: string | null;
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
  /**
   * The latest `limit` history rows of one setting of the Market, newest version first (the
   * primary key's order; G4d3).
   */
  history(
    market: MarketContext,
    code: string,
    limit: number,
  ): Promise<readonly MarketSettingHistoryRecord[]>;
  /** The history row that made `version` of one setting of the Market, or null (G4d3). */
  historyVersion(
    market: MarketContext,
    code: string,
    version: number,
  ): Promise<MarketSettingHistoryRecord | null>;
}

export const MARKET_SETTING_REPOSITORY = Symbol('SETTINGS_MARKET_SETTING_REPOSITORY');
