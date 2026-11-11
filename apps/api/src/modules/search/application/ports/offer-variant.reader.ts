import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { OfferHit, OfferVariantDocument } from '../../domain/offer-document';

/** What a result needs to pick its matching variant and its "From" price (V8). */
export interface HitSellUnits {
  /** The document's own facets (product attributes, brand, country). */
  readonly facetCodes: readonly string[];
  /** Its sell units, in position order. */
  readonly variants: readonly OfferVariantDocument[];
}

/** One sell unit an exact GTIN names. */
export interface GtinUnit {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
}

/** The most sell units one GTIN lookup returns (one item, a few sellers). */
export const MAX_GTIN_UNITS = 20;

/**
 * The variant side of the query (variants V8), over the module's own tables (Prisma, no raw SQL).
 * Every call runs in the caller's read-only unit, for the context's Market only.
 */
export interface OfferVariantReader {
  /** The facets and sell units of these documents; a document that is gone is absent. */
  sellUnitsOf(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, HitSellUnits>>;
  /** The sell units with this 14-digit GTIN, by Offer id, at most {@link MAX_GTIN_UNITS}. */
  unitsWithGtin(market: MarketContext, gtin: string): Promise<readonly GtinUnit[]>;
  /** These documents as hits (rank 0), by Offer id. */
  hitsOf(market: MarketContext, offerIds: readonly Id<'Offer'>[]): Promise<readonly OfferHit[]>;
}

export const OFFER_VARIANT_READER = Symbol('OFFER_VARIANT_READER');
