import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** Who asked for the recount: the admin's "Recalculate now" or the seller's "Refresh now". */
export type SellerHealthRequestSource = 'admin' | 'seller';

export type SellerHealthRequestStatus = 'pending' | 'done' | 'failed';

export interface SellerHealthRequest {
  readonly id: Id;
  readonly sellerId: Id<'Seller'>;
  readonly source: SellerHealthRequestSource;
  readonly requestedAt: Temporal.Instant;
  readonly status: SellerHealthRequestStatus;
}

/** Most pending requests one read returns: the job works through them in batches. */
export const SELLER_HEALTH_REQUEST_PAGE_MAX = 100;

/**
 * `sellers.seller_health_requests`: a request to measure one seller again now. A click only writes
 * a row; the job reads the pending rows as the system actor (the feeds accept no other actor).
 * Every method runs in the caller's unit and is scoped by the Market.
 */
export interface SellerHealthRequestStore {
  /**
   * Writes a pending request unless the seller already has one. `queued` is true when this call
   * wrote the row; false when one was already pending (the click adds nothing).
   */
  enqueue(
    market: MarketContext,
    request: {
      readonly id: Id;
      readonly sellerId: Id<'Seller'>;
      readonly source: SellerHealthRequestSource;
      readonly byAccountId: Id<'Account'>;
      readonly at: Temporal.Instant;
    },
  ): Promise<{ readonly queued: boolean }>;

  /** The oldest pending requests of the Market, at most `limit` (1 to the page maximum). */
  pending(market: MarketContext, limit: number): Promise<readonly SellerHealthRequest[]>;

  /**
   * Marks a pending request done or failed. False when it is no longer pending (another run took
   * it first); the recount is safe to repeat, so the caller just moves on.
   */
  finish(
    market: MarketContext,
    id: Id,
    status: 'done' | 'failed',
    at: Temporal.Instant,
  ): Promise<boolean>;

  /**
   * Deletes the finished (`done` or `failed`) requests of the Market that were requested before
   * `before`, and answers how many went. A pending request is never deleted. Only the retention
   * purge calls it.
   */
  purgeFinishedBefore(market: MarketContext, before: Temporal.Instant): Promise<number>;

  /** The newest request of a seller, any status, or `null`. */
  latest(market: MarketContext, sellerId: Id<'Seller'>): Promise<SellerHealthRequest | null>;
}

export const SELLER_HEALTH_REQUEST_STORE = Symbol('SELLER_HEALTH_REQUEST_STORE');
