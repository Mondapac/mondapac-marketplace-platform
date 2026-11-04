import type { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';

/** One edited name of an area (ADR-0041). */
export interface EditedAreaName {
  readonly areaCode: string;
  readonly locale: string;
  readonly name: string;
}

/**
 * The edited names of service areas in `sellers.service_area_names`. Every method runs in the
 * caller's unit (read-only for `all`) and is scoped by the Market.
 */
export interface ServiceAreaNamesRepository {
  all(market: MarketContext): Promise<readonly EditedAreaName[]>;

  /**
   * Sets a name per language, or removes the edit for a language (null), for one area. Returns how
   * many languages it changed.
   */
  apply(
    market: MarketContext,
    areaCode: string,
    changes: ReadonlyMap<string, string | null>,
    by: Id<'Account'>,
    at: Temporal.Instant,
  ): Promise<number>;
}

export const SERVICE_AREA_NAMES_REPOSITORY = Symbol('SERVICE_AREA_NAMES_REPOSITORY');

/** The edited names of a Market by area code then language, for the overlay on configured names. */
export type EditedNamesByArea = ReadonlyMap<string, Readonly<Record<string, string>>>;

/**
 * Reads the edited names for display. A failed read answers an empty map, so the configured names
 * show: a name is display text and never feeds a decision (ADR-0041 decision 3).
 */
export interface AreaNameSource {
  edited(market: MarketContext): Promise<EditedNamesByArea>;
  /** Forgets the cached answer of a Market after a write. */
  forget(market: MarketContext): void;
}

export const AREA_NAME_SOURCE = Symbol('AREA_NAME_SOURCE');
