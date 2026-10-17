import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * The tax category of each Offer being bought, read through catalog's facade with the caller's
 * `CallContext` unchanged: the PUBLISHED revision's code, nothing from a draft. Unlike the
 * display labels this lookup is not advisory: a line's tax depends on it, so checkout treats a
 * thrown error and an absent Offer alike as "no tax answer, no order".
 */
export interface OrderTaxCategories {
  /** Throws when the owner refuses or fails. An unknown Offer is absent from the map. */
  categoriesOf(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, string>>;
}

export const ORDER_TAX_CATEGORIES = Symbol('ORDER_TAX_CATEGORIES');
