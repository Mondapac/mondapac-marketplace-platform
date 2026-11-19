import type { Id } from '@mondapac/shared-kernel';

/** One row of the store read model: a public store that has indexed Offers. */
export interface StoreDocument {
  readonly sellerId: Id<'Seller'>;
  /** The store address, unique in the Market. */
  readonly slug: string;
  /** The public store name of the approved revision. */
  readonly name: string;
  readonly textSearchConfig: string;
}

/** A store the text query found, before sellers has re-checked it. */
export interface StoreHit {
  readonly sellerId: Id<'Seller'>;
  readonly slug: string;
  readonly name: string;
  /** `ts_rank` of the text query. */
  readonly rank: number;
}
