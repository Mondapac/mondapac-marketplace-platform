import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { OfferPendingChange } from '../../domain/offer-pending-change';
import type { OfferReviewReason } from '../../domain/offer-review-policy';
import type { QueueTextSearch } from './own-catalog.reader';

/**
 * The filters of the admin list of held changes (slice 5). Every filter composes with the others;
 * absent means no filter.
 */
export interface OfferChangeQueueFilter {
  /** Changes that carry any of these reasons. */
  readonly reasons?: readonly OfferReviewReason[];
  readonly sellerId?: Id<'Seller'>;
  /** Changes of Offers whose product's published revision names this platform category. */
  readonly categoryId?: Id<'Category'>;
  /** Submitted at or after this instant (inclusive). */
  readonly submittedFrom?: Temporal.Instant | null;
  /** Submitted before this instant (exclusive). */
  readonly submittedTo?: Temporal.Instant | null;
  /** The review queue's text search: product code, published product name, or a matched store. */
  readonly search?: QueueTextSearch;
}

/** A page of held changes: keyset (`after`, ascending only) or numbered (`offset`). */
export interface OfferChangePage {
  readonly after: { readonly submittedAt: Temporal.Instant; readonly id: string } | null;
  readonly limit: number;
  /** Rows to skip (page numbers); 0 or absent with a keyset. */
  readonly offset?: number;
  /** Submit order; default `asc`. A keyset `after` is ascending only. */
  readonly direction?: 'asc' | 'desc';
}

/**
 * The store of held Offer edits (`catalog.offer_pending_changes`, slice 2c). Every statement takes
 * the caller's Market and runs in the caller's unit. Rows are never deleted. Lock order (Mojtaba):
 * the caller saves the Offer first (its version check), then writes here, then the referral.
 */
export interface OfferPendingChangeRepository {
  /** Inserts a new `pending` change; the partial unique refuses a second open one per Offer. */
  insert(market: MarketContext, change: OfferPendingChange): Promise<void>;

  /**
   * Stores the decision of a change read as `pending`: `UPDATE ... WHERE id AND status =
   * 'pending'`. False when no row moved (another unit decided it first): the caller ends its unit
   * with an error so nothing of it commits.
   */
  decide(market: MarketContext, change: OfferPendingChange): Promise<boolean>;

  /** The Offer's open (`pending`) change, or null. */
  findOpenByOffer(market: MarketContext, offerId: Id<'Offer'>): Promise<OfferPendingChange | null>;

  /** The Offer's latest change in any status (the seller's read), or null. */
  findLatestByOffer(
    market: MarketContext,
    offerId: Id<'Offer'>,
  ): Promise<OfferPendingChange | null>;

  /** The change in this Market, or null: another Market's id is not found. */
  findById(market: MarketContext, id: Id<'OfferPendingChange'>): Promise<OfferPendingChange | null>;

  /**
   * The `pending` changes of the Market that the filter keeps, oldest submit first (then id) or
   * newest first with `direction: 'desc'`, at most `limit` after the position of the previous page
   * (keyset on `submitted_at, id`; null for the first page) or after `offset` rows.
   */
  listPending(
    market: MarketContext,
    page: OfferChangePage,
    filter?: OfferChangeQueueFilter,
  ): Promise<readonly OfferPendingChange[]>;

  /** How many `pending` changes of the Market the filter keeps. */
  countPending(market: MarketContext, filter?: OfferChangeQueueFilter): Promise<number>;
}

export const OFFER_PENDING_CHANGE_REPOSITORY = Symbol('CATALOG_OFFER_PENDING_CHANGE_REPOSITORY');
