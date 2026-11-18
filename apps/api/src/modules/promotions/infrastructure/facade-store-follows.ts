import type { Id } from '@mondapac/shared-kernel';
import type { EngagementFacade } from '../../engagement';
import type { StoreFollows } from '../application/ports/customer-facts';

/** `engagement` answers at most this many sellers per read. */
const SELLERS_PER_READ = 100;

/**
 * {@link StoreFollows} on `engagement`'s facade (customers management phase 3: store follows). The
 * caller's `CallContext` goes unchanged: the system actor (the quote) and a customer asking about
 * their own account each have a read there; anyone else is refused, which is "unknown". A refusal
 * or a failure of any part is "unknown", so the store-follower offer is not made (fail closed).
 */
export class FacadeStoreFollows implements StoreFollows {
  constructor(private readonly engagement: EngagementFacade) {}

  async followedAmong(
    ...[context, accountId, sellerIds]: Parameters<StoreFollows['followedAmong']>
  ): ReturnType<StoreFollows['followedAmong']> {
    const unique = [...new Set(sellerIds)];
    const followed: Id<'Seller'>[] = [];
    for (let start = 0; start < unique.length; start += SELLERS_PER_READ) {
      const part = unique.slice(start, start + SELLERS_PER_READ);
      const read = await this.engagement.followedAmong(context, accountId, part);
      if (!read.ok) return { known: false };
      followed.push(...read.value);
    }
    return { known: true, value: followed };
  }
}
