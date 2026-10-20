import type { MarketContext } from '@mondapac/shared-kernel';
import type { ApprovedStoreFacts } from '../../domain/published-store';

/**
 * The reads behind the public store pages (slice 12). Each runs in the caller's read-only unit,
 * on `sellers`' own rows, and reads clear columns only (no key unwrapped). A seller qualifies
 * when its file has an approved revision (the pointer), that revision is `approved`, and it holds
 * a slug in state `held`. Whether it may sell now is the caller's check (`sellingEligibility`).
 */
export interface PublishedStoreRepository {
  /** Up to `limit` qualifying stores of the Market, in seller id order. */
  approvedStores(market: MarketContext, limit: number): Promise<readonly ApprovedStoreFacts[]>;

  /** The qualifying store holding `slug` in the Market, or null (unknown, retired, not approved). */
  approvedStoreBySlug(market: MarketContext, slug: string): Promise<ApprovedStoreFacts | null>;
}

export const PUBLISHED_STORE_REPOSITORY = Symbol('PUBLISHED_STORE_REPOSITORY');
