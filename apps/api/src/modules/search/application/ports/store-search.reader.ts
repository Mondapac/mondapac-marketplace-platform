import type { MarketContext } from '@mondapac/shared-kernel';
import type { StoreHit } from '../../domain/store-document';

export interface StoreSearchRequest {
  /** The Market's text search configuration. */
  readonly textSearchConfig: string;
  readonly text: string;
  readonly limit: number;
  readonly offset: number;
}

/**
 * The store query: stores of this Market whose name matches the text and that have at least one
 * indexed Offer, in rank order (ties by seller id, so pages are stable). Runs in a read-only unit.
 */
export interface StoreSearchReader {
  searchStores(market: MarketContext, request: StoreSearchRequest): Promise<readonly StoreHit[]>;
}
