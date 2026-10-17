import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { OfferListingsMap, SellUnitKey } from '../../contracts/catalog.facade';

/**
 * The read behind `offerListings` (catalog design 9.1): per key, the published listing of the
 * Offer. Only an Offer that is `published` on a `published` product is answered; every other key
 * is absent. Names, labels and the primary image come from the product's published revision
 * only. `tags` is `none` for the anonymous rule: no tag is read and every listing's `tags` is
 * empty (Hassan, certification revoke review: kept after slice 12 too); `live` answers `active`,
 * `rechecking` and `suspended` tags with status and basis, and the badge data of an `active` tag
 * whose copy is still valid at `now` (slice 12: the revoke and expiry events are consumed, and a
 * copy whose `validUntil` has passed shows no badge even before the expiry event is handled).
 * Runs in a read-only unit.
 */
export interface OfferListingsReader {
  read(
    market: MarketContext,
    keys: readonly SellUnitKey[],
    locales: { readonly requested: string; readonly fallback: string },
    tags: ListingTags,
    now: Temporal.Instant,
  ): Promise<OfferListingsMap>;
}

/** Which tags a listing read answers; decided by the use case's rule, never by input. */
export type ListingTags = 'none' | 'live';

export const OFFER_LISTINGS_READER = Symbol('OFFER_LISTINGS_READER');
