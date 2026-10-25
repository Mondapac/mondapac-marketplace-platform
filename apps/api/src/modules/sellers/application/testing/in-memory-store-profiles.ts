import type { Id, MarketContext, Money } from '@mondapac/shared-kernel';
import type { DeliveryTerms } from '../../domain/delivery-terms';
import type { StoreProfileRepository, StoreSettings } from '../ports/store-profile.repository';

/** A store profile held in memory by a test; `approved` stands for the file's approved pointer. */
export interface StoredProfile {
  version: number;
  approved: boolean;
  minimumOrder: Money | null;
  delivery: DeliveryTerms | null;
  /** The approved revision's public store name; null when the test sets none. */
  publicStoreName?: string | null;
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
      delivery: null,
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

  approvedDeliveryTerms(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, DeliveryTerms>> {
    if (this.failReads) return Promise.reject(new Error('store profiles down'));
    const found = new Map<Id<'Seller'>, DeliveryTerms>();
    for (const sellerId of sellerIds) {
      const profile = this.at(market, sellerId);
      if (profile?.approved === true && profile.delivery !== null) {
        found.set(sellerId, profile.delivery);
      }
    }
    return Promise.resolve(found);
  }

  approvedStoreNames(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, string>> {
    if (this.failReads) return Promise.reject(new Error('store profiles down'));
    const found = new Map<Id<'Seller'>, string>();
    for (const sellerId of sellerIds) {
      const profile = this.at(market, sellerId);
      if (profile?.approved === true && typeof profile.publicStoreName === 'string') {
        found.set(sellerId, profile.publicStoreName);
      }
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

  saveDeliveryTerms(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    change: { expectedVersion: number; delivery: DeliveryTerms | null },
  ): Promise<number | null> {
    const profile = this.at(market, sellerId);
    if (profile === undefined || profile.version !== change.expectedVersion) {
      return Promise.resolve(null);
    }
    this.saves += 1;
    profile.version += 1;
    profile.delivery = change.delivery;
    return Promise.resolve(profile.version);
  }
}
