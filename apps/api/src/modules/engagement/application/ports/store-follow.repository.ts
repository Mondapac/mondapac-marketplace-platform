import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { StoreFollow } from '../../domain/store-follow';

/** Where a page of the customer's follows starts: after this follow (newest first). */
export interface StoreFollowCursor {
  readonly followedAt: Temporal.Instant;
  readonly id: Id<'StoreFollow'>;
}

/**
 * `engagement.store_follows`, one row per Market, account and store. Every method runs inside the
 * caller's unit of work and puts the Market and the account in the statement.
 */
export interface StoreFollowRepository {
  find(
    market: MarketContext,
    accountId: Id<'Account'>,
    sellerId: Id<'Seller'>,
  ): Promise<StoreFollow | null>;
  /** `exists` when the account already follows the store (the unique key). */
  insert(market: MarketContext, follow: StoreFollow): Promise<'inserted' | 'exists'>;
  /** Removes one follow of the account; false when it was already gone. */
  remove(market: MarketContext, accountId: Id<'Account'>, id: Id<'StoreFollow'>): Promise<boolean>;
  countOf(market: MarketContext, accountId: Id<'Account'>): Promise<number>;
  /** The account's follows, newest first, after `after`, at most `limit`. */
  pageOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    after: StoreFollowCursor | null,
    limit: number,
  ): Promise<readonly StoreFollow[]>;
  /** Which of `sellerIds` the account follows (at most 100 ids asked). */
  followedAmong(
    market: MarketContext,
    accountId: Id<'Account'>,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<readonly StoreFollow[]>;
  /** Every follow of the account (bounded by {@link MAX_FOLLOWS_PER_ACCOUNT}). */
  allOf(market: MarketContext, accountId: Id<'Account'>): Promise<readonly StoreFollow[]>;
  /** Deletes every follow of the account (erasure); answers how many. */
  deleteForAccount(market: MarketContext, accountId: Id<'Account'>): Promise<number>;
}

export const STORE_FOLLOW_REPOSITORY = Symbol('ENGAGEMENT_STORE_FOLLOW_REPOSITORY');
