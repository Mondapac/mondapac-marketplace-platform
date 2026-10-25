import type { ContentHash, Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** The sealed JSON of a revision (sellers design 8.1): opaque to the application, like every ciphertext. */
export type SealedStoreProfileContent = string & { readonly __sealed: 'store-profile-content' };

/** The published revision of a store profile, as the clear columns tell it. */
export interface PublishedRevisionRef {
  readonly revisionId: Id<'StoreProfileRevision'>;
  /** 1, 2, ...: the "version" the About text is saved against. */
  readonly revisionNo: number;
  /** The keyed hash of the content, to tell a save that changes nothing. */
  readonly contentHash: ContentHash;
}

export interface NewStoreProfileRevision {
  readonly id: Id<'StoreProfileRevision'>;
  /** The revision number the writer read as published (0: none). The new revision is the next. */
  readonly expectedRevisionNo: number;
  readonly ciphertext: SealedStoreProfileContent;
  readonly schemaVersion: number;
  readonly contentHash: ContentHash;
  readonly authorAccountId: Id<'Account'>;
  readonly createdAt: Temporal.Instant;
}

/**
 * The revisions of a store's public texts (data design 3.8, slice 12 part 2). Every method runs
 * in the open unit of its caller, on `sellers`' own rows. A revision is insert-only.
 */
export interface StoreProfileContentRepository {
  /**
   * The published revision of the seller, or null: no profile row, no save yet, or another
   * Market's seller. The pointer is read in clear on every call (sellers design 8.1, Hassan M5).
   */
  published(market: MarketContext, sellerId: Id<'Seller'>): Promise<PublishedRevisionRef | null>;

  /** The sealed content of one revision of the seller, or null when it is not the seller's. */
  content(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    revisionId: Id<'StoreProfileRevision'>,
  ): Promise<SealedStoreProfileContent | null>;

  /**
   * Inserts the revision and moves the published pointer to it, only while the published
   * revision number is still `expectedRevisionNo`. `stale` writes nothing (another save came
   * first); `no-profile` is a seller with no store profile row.
   */
  publish(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    revision: NewStoreProfileRevision,
  ): Promise<'published' | 'stale' | 'no-profile'>;
}

export const STORE_PROFILE_CONTENT_REPOSITORY = Symbol('STORE_PROFILE_CONTENT_REPOSITORY');
