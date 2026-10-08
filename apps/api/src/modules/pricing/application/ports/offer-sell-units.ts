import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * What pricing reads of one Offer to decide a seller's write (pricing design 5.2, 6.1 CF1):
 * pricing's own view of catalog's `offerSellUnits` answer, so the use cases depend on this port
 * and not on catalog's types. Ids and a flag only.
 */
export interface PricedOfferView {
  readonly sellerId: Id<'Seller'>;
  /** The only source of a series' `productId` copy (design 2.3; Hassan L4), never the request. */
  readonly productId: Id<'Product'>;
  /** catalog's `deleted` status: present, with no sell units (P-1). */
  readonly deleted: boolean;
  /** The Variants that may carry a price: the product's non-retired ones, `proposed` included. */
  readonly priceableVariantIds: ReadonlySet<Id<'Variant'>>;
}

/** At most this many Offer ids per call; a larger call is refused whole (design 5.2, P-1). */
export const MAX_OFFER_IDS_PER_CALL = 200;

/**
 * catalog's `offerSellUnits` seen from pricing (design 6.1 CF1). Advisory (ADR-0025 decision
 * 1): read outside the write unit, so it can be stale by commit; deletions that land after it
 * are closed by the tombstones and the serializable units (design 6.4, 9). Called before any
 * unit opens (P 3.1 row 5: no facade call inside a unit).
 *
 * The map holds an entry per requested Offer that catalog answered for the context's Market;
 * an unknown id and another Market's id are both absent. Throws when catalog cannot answer (an
 * error is never read as "absent", and never as permission).
 */
export interface OfferSellUnitsSource {
  sellUnitsOf(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, PricedOfferView>>;
}

export const OFFER_SELL_UNITS_SOURCE = Symbol('OFFER_SELL_UNITS_SOURCE');

/** catalog refused or failed the call: the write answers nothing and is logged as unavailable. */
export class OfferSellUnitsUnavailableError extends Error {
  override readonly name = 'OfferSellUnitsUnavailableError';
  constructor(readonly code: string) {
    super(`catalog offerSellUnits refused: ${code}`);
  }
}
