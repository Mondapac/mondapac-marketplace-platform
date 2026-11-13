import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type { PublicStore, StoreDirectory } from '../application/ports/store-directory';

/** Sellers' facade takes at most 100 ids per call. */
const BATCH = 100;

/**
 * {@link StoreDirectory} over sellers' `publishedStoreSlugs` (published stores only: an approved
 * revision, a held address, may sell now) and `sellerSummaries` (the public store name of the
 * approved revision). Any refusal or failure is `null`.
 */
export class FacadeStoreDirectory implements StoreDirectory {
  constructor(private readonly sellers: SellersFacade) {}

  async publicStores(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, PublicStore> | null> {
    const distinct = [...new Set(sellerIds)];
    const stores = new Map<Id<'Seller'>, PublicStore>();
    try {
      for (let at = 0; at < distinct.length; at += BATCH) {
        const batch = distinct.slice(at, at + BATCH);
        const slugs = await this.sellers.publishedStoreSlugs(context, batch);
        if (!slugs.ok) return null;
        if (slugs.value.size === 0) continue;
        const summaries = await this.sellers.sellerSummaries(context, [...slugs.value.keys()]);
        if (!summaries.ok) return null;
        for (const summary of summaries.value) {
          const slug = slugs.value.get(summary.sellerId);
          if (slug !== undefined && summary.storeName !== null && summary.storeName !== '') {
            stores.set(summary.sellerId, { slug, name: summary.storeName });
          }
        }
      }
    } catch {
      return null;
    }
    return stores;
  }
}
