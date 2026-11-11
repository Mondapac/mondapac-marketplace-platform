import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { VariantRequest, VariantRequestStatus } from '../../domain/variant-request';

/**
 * The store of sellers' variant requests (variants plan, package V7). Every method runs in the
 * open unit of the use case, through the Market-scoped client. Rows are never deleted: a decision
 * is one conditional update out of `open`, and a notice move is one conditional update out of
 * `pending`.
 */
export interface VariantRequestStore {
  findById(market: MarketContext, id: Id<'VariantRequest'>): Promise<VariantRequest | null>;

  /**
   * Inserts a new open request. Answers `variant-request.already-open` when the Offer already has
   * an open request for the same option values (the open partial unique).
   */
  add(
    market: MarketContext,
    request: VariantRequest,
  ): Promise<'variant-request.already-open' | null>;

  /**
   * Writes a decision built by the domain (version one above the stored one), only from `open` at
   * the version before. Throws `StaleAggregateError` when another decision won.
   */
  saveDecision(market: MarketContext, request: VariantRequest): Promise<void>;

  /**
   * Writes a notice move built by the domain, only from `pending` at the version before. Throws
   * `StaleAggregateError` when the notice moved meanwhile.
   */
  saveNotice(market: MarketContext, request: VariantRequest): Promise<void>;

  /** How many requests of this seller are open. */
  openCountOfSeller(market: MarketContext, sellerId: Id<'Seller'>): Promise<number>;

  /** How many requests this seller made since `since`, in any status. */
  madeSince(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    since: Temporal.Instant,
  ): Promise<number>;

  /** Open requests, oldest first, at most `limit`. */
  listOpen(market: MarketContext, limit: number): Promise<readonly VariantRequest[]>;

  /**
   * One seller's requests, newest first (by id, a UUID v7), keyset-paged: rows after `afterId`
   * only, at most `limit`, optionally of one status.
   */
  listOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    page: {
      readonly status: VariantRequestStatus | null;
      readonly afterId: Id<'VariantRequest'> | null;
      readonly limit: number;
    },
  ): Promise<readonly VariantRequest[]>;

  /** Decided requests whose notice is pending and due at `now`, oldest first, at most `limit`. */
  dueNotices(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly VariantRequest[]>;
}

export const VARIANT_REQUEST_STORE = Symbol('VARIANT_REQUEST_STORE');
