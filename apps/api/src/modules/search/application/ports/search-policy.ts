import type { MarketContext } from '@mondapac/shared-kernel';

export interface SearchSettings {
  /** A built-in PostgreSQL text search configuration (Market config `search.textSearchConfig`). */
  readonly textSearchConfig: string;
  /** The Market's default locale: the text of this locale is indexed and shown. */
  readonly locale: string;
}

/** The Market's search settings. Never falls back to another Market. */
export interface SearchPolicy {
  settings(market: MarketContext): SearchSettings;
}

export const SEARCH_POLICY = Symbol('SEARCH_POLICY');
