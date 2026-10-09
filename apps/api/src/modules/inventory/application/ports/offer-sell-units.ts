import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * What inventory reads of one Offer to decide a seller's stock write (inventory design 4.5):
 * its view of catalog's `offerSellUnits` answer, so the use cases depend on this port and not on
 * catalog's types. Ids and a flag only.
 */
export interface StockOfferView {
  readonly sellerId: Id<'Seller'>;
  /** The Product the Offer sells now; a move changes it (catalog `offer-moved`). */
  readonly productId: Id<'Product'>;
  /** catalog's `deleted` status: present, with no sell units. */
  readonly deleted: boolean;
  /** The Variants that may carry stock: the product's non-retired ones, `proposed` included. */
  readonly sellUnitVariantIds: ReadonlySet<Id<'Variant'>>;
}

/** At most this many Offer ids per call; a larger call is refused whole (catalog design 9.1). */
export const MAX_OFFER_IDS_PER_CALL = 200;

/**
 * catalog's `offerSellUnits` seen from inventory. Advisory (ADR-0025 decision 1): read outside
 * the write unit, so it can be stale by commit; the tombstones inside the serializable unit are
 * the backstop (design 3.5, 4.5). Never called inside a unit (P 3.1 row 5).
 *
 * The map holds an entry per requested Offer that catalog answered for the context's Market; an
 * unknown id and another Market's id are both absent. Throws when catalog cannot answer: an error
 * is never read as "absent", and never as permission.
 */
export interface OfferSellUnitsSource {
  sellUnitsOf(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, StockOfferView>>;
}

export const OFFER_SELL_UNITS_SOURCE = Symbol('OFFER_SELL_UNITS_SOURCE');

/** catalog refused or failed the call: the write answers nothing and the failure is logged. */
export class OfferSellUnitsUnavailableError extends Error {
  override readonly name = 'OfferSellUnitsUnavailableError';
  constructor(readonly code: string) {
    super(`catalog offerSellUnits refused: ${code}`);
  }
}
