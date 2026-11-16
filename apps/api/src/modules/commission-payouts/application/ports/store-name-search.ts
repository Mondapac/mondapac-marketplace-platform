import type { CallContext, Id } from '@mondapac/shared-kernel';

export const STORE_NAME_SEARCH = Symbol('COMMISSION_PAYOUTS_STORE_NAME_SEARCH');

/**
 * sellers' `searchStoreNames`: the sellers whose approved public store name contains `term`
 * (a list's search box). The term is never logged. Throws when the read failed; the list then
 * refuses the search instead of showing every row.
 */
export interface StoreNameSearch {
  storesMatching(
    context: CallContext,
    term: string,
  ): Promise<{ readonly sellerIds: readonly Id<'Seller'>[]; readonly capped: boolean }>;
}
