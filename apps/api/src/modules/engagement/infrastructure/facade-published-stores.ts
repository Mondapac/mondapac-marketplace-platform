import { err, ok } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type { PublishedStores } from '../application/ports/published-stores';

/**
 * {@link PublishedStores} on `sellers`' `publishedStoreSlugs` (rule `anonymous`: the caller's
 * context is passed unchanged and the gate gives sellers the Market's anonymous actor). Any
 * refusal or fault is `engagement.unavailable`.
 */
export class FacadePublishedStores implements PublishedStores {
  constructor(private readonly sellers: SellersFacade) {}

  async slugsOf(...[context, sellerIds]: Parameters<PublishedStores['slugsOf']>) {
    if (sellerIds.length === 0) return ok(new Map());
    try {
      const read = await this.sellers.publishedStoreSlugs(context, sellerIds);
      return read.ok ? ok(read.value) : err({ code: 'engagement.unavailable' as const });
    } catch {
      return err({ code: 'engagement.unavailable' as const });
    }
  }
}
