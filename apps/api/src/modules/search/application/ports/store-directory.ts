import type { CallContext, Id } from '@mondapac/shared-kernel';

/** What the public knows of a store: its address and its public name. */
export interface PublicStore {
  readonly slug: string;
  readonly name: string;
}

/**
 * The public stores among these sellers, through sellers' contracts (system actor): a store has
 * an approved revision, a held address and a seller who may sell now, so a suspended or unapproved
 * seller is absent. `null` when sellers cannot answer; the caller throws so the delivery or the
 * rebuild is retried, never an index that silently loses store names.
 */
export interface StoreDirectory {
  publicStores(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, PublicStore> | null>;
}

export const STORE_DIRECTORY = Symbol('STORE_DIRECTORY');
