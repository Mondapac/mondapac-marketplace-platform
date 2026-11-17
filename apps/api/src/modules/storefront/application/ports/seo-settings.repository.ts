import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { SeoSettings } from '../../domain/seo-settings';

/** One stored version of a Market's SEO settings. */
export interface SeoSettingsRecord {
  readonly version: number;
  readonly settings: SeoSettings;
  readonly changedAt: Temporal.Instant;
}

/**
 * The SEO settings history of one Market (`storefront.seo_settings`, insert-only). Every method
 * runs inside the caller's unit of work and is scoped by the Market.
 */
export interface SeoSettingsRepository {
  /** The newest version, or null before the first admin change. */
  latest(market: MarketContext): Promise<SeoSettingsRecord | null>;

  /** One older version, or null when there is none. */
  find(market: MarketContext, version: number): Promise<SeoSettingsRecord | null>;

  /** Appends the next version; false when that version already exists (a concurrent change). */
  append(
    market: MarketContext,
    record: SeoSettingsRecord & { readonly changedBy: Id<'Account'> },
  ): Promise<boolean>;
}

export const SEO_SETTINGS_REPOSITORY = Symbol('SEO_SETTINGS_REPOSITORY');
