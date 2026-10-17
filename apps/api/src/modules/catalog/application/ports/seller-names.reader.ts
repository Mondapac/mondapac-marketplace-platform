import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * The public store names of sellers, for the admin review queue (catalog design 9.6
 * `sellerSummaries`). An unknown seller, one without an approved revision and any failure give no
 * entry: the queue shows the row without a name, never a guess. At most 100 ids per page.
 */
export interface SellerNamesReader {
  storeNames(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, string>>;
}

export const SELLER_NAMES_READER = Symbol('SELLER_NAMES_READER');
