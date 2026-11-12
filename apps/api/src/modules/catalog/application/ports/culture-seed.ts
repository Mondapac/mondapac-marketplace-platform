import type { MarketContext } from '@mondapac/shared-kernel';
import type { CultureName } from '../../domain/culture';

/** One culture of a checked-in seed. */
export interface SeededCulture {
  readonly code: string;
  readonly displayOrder: number;
  /** A certification type code that certification's seed creates, or null. */
  readonly requiredCertificationType: string | null;
  readonly badgeColour: string | null;
  /** Marks the Market's default culture; applied only while the Market has none. */
  readonly isDefault: boolean;
  readonly names: readonly CultureName[];
}

/**
 * The versioned seed of the first cultures per Market (multi-culture package 1; ADR-0047). It is
 * data: core code never names a culture. A Market with no seed gets none.
 */
export interface CultureSeed {
  cultures(market: MarketContext): readonly SeededCulture[];
}

export const CULTURE_SEED = Symbol('CULTURE_SEED');
