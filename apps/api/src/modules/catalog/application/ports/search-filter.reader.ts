import type { MarketContext } from '@mondapac/shared-kernel';
import type { LoadedSearchDefinition } from '../../domain/search-attributes';

/** An active brand as a filter option needs it. */
export interface FilterBrand {
  readonly slug: string;
  readonly name: string;
}

/**
 * The reads behind the storefront filter lists (attributes A7): the published definitions of
 * some attribute codes, and the names of some active brands. Runs in the caller's read-only unit.
 */
export interface SearchFilterReader {
  definitions(
    market: MarketContext,
    codes: readonly string[],
  ): Promise<ReadonlyMap<string, LoadedSearchDefinition>>;
  brands(market: MarketContext, slugs: readonly string[]): Promise<readonly FilterBrand[]>;
}

export const SEARCH_FILTER_READER = Symbol('SEARCH_FILTER_READER');
