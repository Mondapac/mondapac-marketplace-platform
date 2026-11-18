import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * The product of each Offer being bought, read through catalog's facade with the caller's
 * `CallContext` unchanged: promotions target products, so checkout's quote names each line's
 * product (package T2). Not advisory: a line whose product is unknown fails the checkout closed.
 */
export interface OrderProducts {
  /** Throws when the owner refuses or fails. An unknown Offer is absent from the map. */
  productsOf(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, Id<'Product'>>>;
}

export const ORDER_PRODUCTS = Symbol('ORDER_PRODUCTS');
