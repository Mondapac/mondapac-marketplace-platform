import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { AccountDeletionSettings } from '../../domain/account-deletion-settings';

/** One stored version of a Market's account deletion setting. */
export interface AccountDeletionSettingsRecord {
  readonly version: number;
  readonly settings: AccountDeletionSettings;
  readonly changedAt: Temporal.Instant;
}

/**
 * The account deletion setting history of one Market (`customers.account_deletion_settings`,
 * insert-only). Every method runs inside the caller's unit of work and is scoped by the Market.
 */
export interface AccountDeletionSettingsRepository {
  /** The newest version, or null before the first admin change. */
  latest(market: MarketContext): Promise<AccountDeletionSettingsRecord | null>;

  /** Appends the next version; false when that version already exists (a concurrent change). */
  append(
    market: MarketContext,
    record: AccountDeletionSettingsRecord & {
      readonly changedBy: Id<'Account'>;
      /** Why the admin made the change; kept in the history row only. */
      readonly reason: string;
    },
  ): Promise<boolean>;
}

export const ACCOUNT_DELETION_SETTINGS_REPOSITORY = Symbol('ACCOUNT_DELETION_SETTINGS_REPOSITORY');
