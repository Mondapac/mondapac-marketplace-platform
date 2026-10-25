import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * The seller behind a public store address, under the rules of the public store page (sellers'
 * `publishedStoreSellerId`, fail closed): `null` for an unknown, retired or not-selling store.
 */
export interface StoreDirectory {
  sellerOf(context: CallContext, slug: string): Promise<Id<'Seller'> | null | 'unavailable'>;
}

export const STORE_DIRECTORY = Symbol('STORE_DIRECTORY');
