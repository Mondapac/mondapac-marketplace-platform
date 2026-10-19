import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { AssistantSettings } from '../../domain/assistant-settings';

/** One stored version of a Market's assistant settings. */
export interface AssistantSettingsRecord {
  readonly version: number;
  readonly settings: AssistantSettings;
  readonly changedAt: Temporal.Instant;
}

/**
 * The assistant settings history of one Market (`assistant.settings`, insert-only). Every method
 * runs inside the caller's unit of work and is scoped by the Market.
 */
export interface AssistantSettingsRepository {
  /** The newest version, or null before the first admin change. */
  latest(market: MarketContext): Promise<AssistantSettingsRecord | null>;

  /** Appends the next version; false when that version already exists (a concurrent change). */
  append(
    market: MarketContext,
    record: AssistantSettingsRecord & { readonly changedBy: Id<'Account'> },
  ): Promise<boolean>;
}

export const ASSISTANT_SETTINGS_REPOSITORY = Symbol('ASSISTANT_SETTINGS_REPOSITORY');
