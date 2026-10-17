import type { MarketContext } from '@mondapac/shared-kernel';
import type { OfferListingsMap, SellUnitKey } from '../../contracts/catalog.facade';

/**
 * The read behind `offerListings` (catalog design 9.1): per key, the published listing of the
 * Offer. Only an Offer that is `published` on a `published` product is answered; every other key
 * is absent. Names, labels and the primary image come from the product's published revision
 * only. `tags` is `none` for the anonymous rule: no tag is read and every listing's `tags` is
 * empty (a stored `active` tag can outlive its certificate until slice 12 consumes the revoke
 * and expiry events); `live` answers `active`, `rechecking` and `suspended` tags with status and
 * basis, and no badge data until slice 12 (Hassan L-1). Runs in a read-only unit.
 */
export interface OfferListingsReader {
  read(
    market: MarketContext,
    keys: readonly SellUnitKey[],
    locales: { readonly requested: string; readonly fallback: string },
    tags: ListingTags,
  ): Promise<OfferListingsMap>;
}

/** Which tags a listing read answers; decided by the use case's rule, never by input. */
export type ListingTags = 'none' | 'live';

export const OFFER_LISTINGS_READER = Symbol('OFFER_LISTINGS_READER');
