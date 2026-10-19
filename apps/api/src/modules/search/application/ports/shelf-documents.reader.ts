import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { OfferHit } from '../../domain/offer-document';

/**
 * The documents a shelf is drawn from (the module's own read model). Runs in the caller's
 * read-only unit; documents of this Market only; `rank` is 0.
 */
export interface ShelfDocumentsReader {
  /** The documents of these Offers that are indexed, in any order; absent ones are left out. */
  byOfferIds(market: MarketContext, offerIds: readonly Id<'Offer'>[]): Promise<readonly OfferHit[]>;
  /** The first `limit` documents of the Market in search's browse order (name, then Offer id). */
  browseAll(market: MarketContext, limit: number): Promise<readonly OfferHit[]>;
}

export const SHELF_DOCUMENTS_READER = Symbol('SHELF_DOCUMENTS_READER');
