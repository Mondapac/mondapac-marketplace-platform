import type { CallContext, Id, Result } from '@mondapac/shared-kernel';

/** A store's current logo as a ref to the public image route (`GET sellers/stores/:slug/images/:id/:size`). */
export interface StoreLogoRef {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

/** What "My stores" shows of a store the public can see now. Public fields only. */
export interface PublishedStoreCard {
  readonly slug: string;
  readonly name: string;
  readonly logo: StoreLogoRef | null;
}

/**
 * Which sellers have a store the public can see now (approved, a held store address, may sell),
 * as `sellers` answers it, with that address. Ids and slugs only. A fault is an error, never an
 * empty answer: the follow is refused rather than made on a guess.
 */
export interface PublishedStores {
  slugsOf(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<
    Result<ReadonlyMap<Id<'Seller'>, string>, { readonly code: 'engagement.unavailable' }>
  >;

  /**
   * The address, public name and logo of each store the public can see now. A store that is not
   * public is absent from the map: its name and logo are never read or answered. A fault is an
   * error, never an empty answer.
   */
  cardsOf(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<
    Result<
      ReadonlyMap<Id<'Seller'>, PublishedStoreCard>,
      { readonly code: 'engagement.unavailable' }
    >
  >;
}

export const PUBLISHED_STORES = Symbol('ENGAGEMENT_PUBLISHED_STORES');
