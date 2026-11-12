import type { MarketContext } from '@mondapac/shared-kernel';
import type { CultureState, CultureStatus } from '../../domain/culture';

export interface CultureListQuery {
  readonly status: CultureStatus | null;
  /** Matches a name in any locale or the code; case-insensitive. */
  readonly search: string | null;
}

/** The reads of the culture package, in a read-only unit. */
export interface CultureReader {
  /** By display order, then code. A Market holds at most 200 cultures, so the list is not paged. */
  list(market: MarketContext, query: CultureListQuery): Promise<readonly CultureState[]>;
}

export const CULTURE_READER = Symbol('CULTURE_READER');
