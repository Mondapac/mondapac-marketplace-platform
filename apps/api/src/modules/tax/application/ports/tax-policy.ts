import type { MarketContext } from '@mondapac/shared-kernel';

/** The Market's tax settings (Market config `tax` and the catalog's tax categories). */
export interface TaxSettings {
  /** The rate of the built-in flat strategy, in basis points (AU 1000). */
  readonly defaultRateBps: number;
  /** The tax category codes of the Market: what a by-category strategy may name. */
  readonly categoryCodes: readonly string[];
}

export interface TaxPolicy {
  /** Null when the Market has no tax settings: tax is unavailable (fail closed). */
  settings(market: MarketContext): TaxSettings | null;
}

export const TAX_POLICY = Symbol('TAX_POLICY');
