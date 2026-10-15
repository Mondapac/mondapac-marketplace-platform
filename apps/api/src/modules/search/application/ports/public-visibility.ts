import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * The query-time re-check: of these Offers, which are still sellable now (catalog says
 * published and listed) and whose seller may sell (sellers' may-sell contract). The index can
 * lag behind a suspension or an off-sale cause, so a result is never shown on the index alone.
 * `null` when a check failed: the caller fails closed.
 */
export interface PublicVisibility {
  visible(
    context: CallContext,
    offers: readonly { readonly offerId: Id<'Offer'>; readonly sellerId: Id<'Seller'> }[],
  ): Promise<ReadonlySet<Id<'Offer'>> | null>;
}

export const PUBLIC_VISIBILITY = Symbol('PUBLIC_VISIBILITY');
