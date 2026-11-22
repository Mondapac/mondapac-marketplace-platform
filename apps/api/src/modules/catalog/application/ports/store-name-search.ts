import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * The sellers whose approved public store name contains a text (case-insensitive), for the admin
 * review queue search. On `sellers.searchStoreNames`: only the store name the public sees, never a
 * draft or the legal name. At most 200 sellers; `capped` is true when more matched. A failed read
 * throws: the caller fails closed rather than show a queue without the store matches.
 */
export interface StoreNameSearch {
  sellersMatching(
    context: CallContext,
    text: string,
  ): Promise<{ readonly sellerIds: readonly Id<'Seller'>[]; readonly capped: boolean }>;
}

export const STORE_NAME_SEARCH = Symbol('STORE_NAME_SEARCH');
