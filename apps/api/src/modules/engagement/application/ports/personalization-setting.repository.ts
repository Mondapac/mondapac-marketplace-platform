import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** A customer's personalization switch. No row means on (owner decision 4: they may switch it off). */
export interface PersonalizationSettingRecord {
  readonly id: Id<'PersonalizationSetting'>;
  readonly accountId: Id<'Account'>;
  readonly enabled: boolean;
  readonly changedAt: Temporal.Instant;
  readonly createdAt: Temporal.Instant;
}

/**
 * `engagement.personalization_settings`, one row per Market and account. Runs inside the caller's
 * unit of work.
 */
export interface PersonalizationSettingRepository {
  find(
    market: MarketContext,
    accountId: Id<'Account'>,
  ): Promise<PersonalizationSettingRecord | null>;
  /** Inserts the row or changes `enabled` and `changedAt`. */
  save(market: MarketContext, setting: PersonalizationSettingRecord): Promise<void>;
  /** Deletes the account's row; answers whether there was one. */
  delete(market: MarketContext, accountId: Id<'Account'>): Promise<boolean>;
  /**
   * Locks the account's behaviour until the unit ends: `shared` to record an event, `exclusive`
   * to switch personalization or forget the account. Taken first in the unit.
   */
  lockAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
    mode: 'shared' | 'exclusive',
  ): Promise<void>;
}

export const PERSONALIZATION_SETTING_REPOSITORY = Symbol('PERSONALIZATION_SETTING_REPOSITORY');
