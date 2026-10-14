import type { Id, MarketContext, Money } from '@mondapac/shared-kernel';
import type { StoreProfileRepository, StoreSettings } from '../ports/store-profile.repository';

/** A store profile held in memory by a test; `approved` stands for the file's approved pointer. */
export interface StoredProfile {
  version: number;
  approved: boolean;
  minimumOrder: Money | null;
}

/** An in-memory {@link StoreProfileRepository} keyed by `<market>|<seller>`. */
export class InMemoryStoreProfiles implements StoreProfileRepository {
  readonly stored = new Map<string, StoredProfile>();
  failReads = false;
  saves = 0;

  put(market: MarketContext, sellerId: Id<'Seller'>, profile: Partial<StoredProfile> = {}): void {
    this.stored.set(`${market.marketId}|${sellerId}`, {
      version: 1,
      approved: true,
      minimumOrder: null,
      ...profile,
    });
  }

  at(market: MarketContext, sellerId: Id<'Seller'>): StoredProfile | undefined {
    return this.stored.get(`${market.marketId}|${sellerId}`);
  }

  approvedMinimumOrders(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, Money | null>> {
    if (this.failReads) return Promise.reject(new Error('store profiles down'));
    const found = new Map<Id<'Seller'>, Money | null>();
    for (const sellerId of sellerIds) {
      const profile = this.at(market, sellerId);
      if (profile?.approved === true) found.set(sellerId, profile.minimumOrder);
    }
    return Promise.resolve(found);
  }

  find(market: MarketContext, sellerId: Id<'Seller'>): Promise<StoreSettings | null> {
    const profile = this.at(market, sellerId);
    return Promise.resolve(profile === undefined ? null : { ...profile });
  }

  saveMinimumOrder(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    change: { expectedVersion: number; minimumOrder: Money | null },
  ): Promise<number | null> {
    const profile = this.at(market, sellerId);
    if (profile === undefined || profile.version !== change.expectedVersion) {
      return Promise.resolve(null);
    }
    this.saves += 1;
    profile.version += 1;
    profile.minimumOrder = change.minimumOrder;
    return Promise.resolve(profile.version);
  }
}
