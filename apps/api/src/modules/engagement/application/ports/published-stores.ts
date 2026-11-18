import type { CallContext, Id, Result } from '@mondapac/shared-kernel';

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
}

export const PUBLISHED_STORES = Symbol('ENGAGEMENT_PUBLISHED_STORES');
