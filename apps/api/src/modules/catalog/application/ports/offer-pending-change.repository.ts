import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { OfferPendingChange } from '../../domain/offer-pending-change';

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
   * The `pending` changes of the Market, oldest submit first (then id), at most `limit` after the
   * position of the previous page (keyset on `submitted_at, id`; null for the first page).
   */
  listPending(
    market: MarketContext,
    page: {
      readonly after: { readonly submittedAt: Temporal.Instant; readonly id: string } | null;
      readonly limit: number;
    },
  ): Promise<readonly OfferPendingChange[]>;
}

export const OFFER_PENDING_CHANGE_REPOSITORY = Symbol('CATALOG_OFFER_PENDING_CHANGE_REPOSITORY');
