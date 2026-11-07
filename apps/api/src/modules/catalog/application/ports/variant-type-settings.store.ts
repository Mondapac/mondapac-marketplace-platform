import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { VariantTypeSettings } from '../../domain/variant-type-settings';

/**
 * The store behind a variant type's display settings (variants V6). Every method runs in the open
 * unit of the use case through the Market-scoped client. Nothing is deleted: a change is a new
 * insert-only revision and the root's pointer moves to it. A write whose settings changed since
 * they were read throws `StaleAggregateError`.
 */
export interface VariantTypeSettingsStore {
  /** The stored settings of this definition, or null while it uses the defaults. */
  find(
    market: MarketContext,
    definitionId: Id<'AttributeDefinition'>,
  ): Promise<VariantTypeSettings | null>;

  /** Inserts the first settings built by `VariantTypeSettings.create`. */
  add(
    market: MarketContext,
    settings: VariantTypeSettings,
    authorAccountId: Id<'Account'>,
  ): Promise<void>;

  /** Inserts the revision built by `revise` and points the root at it behind its version. */
  saveRevision(
    market: MarketContext,
    settings: VariantTypeSettings,
    authorAccountId: Id<'Account'>,
  ): Promise<void>;
}

export const VARIANT_TYPE_SETTINGS_STORE = Symbol('VARIANT_TYPE_SETTINGS_STORE');
