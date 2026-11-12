import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  CategoryProposalView,
  ProposalCancelReason,
  ProposalRejectReason,
  ShelfText,
  ShelfView,
} from '../../domain/seller-category';

export interface NewCategoryProposal {
  readonly id: Id<'CategoryProposal'>;
  readonly sellerId: Id<'Seller'>;
  readonly platformParentId: Id<'Category'>;
  readonly texts: readonly ShelfText[];
  readonly normalisedName: string;
  readonly now: Temporal.Instant;
}

export interface NewShelf {
  readonly id: Id<'SellerCategory'>;
  readonly sellerId: Id<'Seller'>;
  readonly platformParentId: Id<'Category'>;
  readonly slug: string;
  readonly texts: readonly ShelfText[];
  readonly now: Temporal.Instant;
}

/** One proposal decision: a conditional update out of `pending` at the version read. */
export type ProposalDecision =
  | {
      readonly status: 'approved';
      readonly by: Id<'Account'>;
      readonly shelfId: Id<'SellerCategory'>;
    }
  | {
      readonly status: 'rejected';
      readonly by: Id<'Account'>;
      readonly reason: ProposalRejectReason;
    }
  | { readonly status: 'cancelled'; readonly reason: ProposalCancelReason };

/** Who changed an Offer's shelf, for its history row (data design 3.14). */
export interface ShelfActor {
  readonly kind: 'seller' | 'admin' | 'system';
  readonly accountId: Id<'Account'> | null;
  readonly actingAdminAccountId: Id<'Account'> | null;
}

/**
 * The store of seller shelves and category proposals (categories C9a; data design 3.22, 3.13).
 * Every method runs in the open unit of the use case through the Market-scoped client, with
 * `marketId` in every `where`. Proposals and shelves are never deleted.
 */
export interface SellerCategoryStore {
  /** Inserts a pending proposal; `proposal.duplicate` when the pending unique refuses it. */
  addProposal(
    market: MarketContext,
    proposal: NewCategoryProposal,
  ): Promise<'proposal.duplicate' | null>;

  /** Pending proposals of the seller (the CAT-54 soft cap). */
  pendingCount(market: MarketContext, sellerId: Id<'Seller'>): Promise<number>;

  /**
   * Whether the seller already has an active shelf under the parent whose proposal had this
   * normalised name.
   */
  activeShelfNamed(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    platformParentId: Id<'Category'>,
    normalisedName: string,
  ): Promise<boolean>;

  findProposal(
    market: MarketContext,
    id: Id<'CategoryProposal'>,
  ): Promise<CategoryProposalView | null>;

  /**
   * Writes the decision from `pending` at `expectedVersion`; false when another decision (or a
   * cancellation) won, and nothing was written.
   */
  decideProposal(
    market: MarketContext,
    id: Id<'CategoryProposal'>,
    expectedVersion: number,
    decision: ProposalDecision,
    now: Temporal.Instant,
  ): Promise<boolean>;

  /** Cancels every pending proposal of the seller; answers the ids cancelled, oldest first. */
  cancelPendingOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    reason: ProposalCancelReason,
    now: Temporal.Instant,
  ): Promise<readonly { readonly id: Id<'CategoryProposal'>; readonly version: number }[]>;

  /** Pending proposals of the Market, oldest first, after the keyset cursor. */
  listPending(
    market: MarketContext,
    page: { readonly after: Id<'CategoryProposal'> | null; readonly limit: number },
  ): Promise<readonly CategoryProposalView[]>;

  /** One seller's proposals, newest first, at most `limit`. */
  listOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    limit: number,
  ): Promise<readonly CategoryProposalView[]>;

  slugTaken(market: MarketContext, sellerId: Id<'Seller'>, slug: string): Promise<boolean>;

  insertShelf(market: MarketContext, shelf: NewShelf): Promise<void>;

  findShelf(market: MarketContext, id: Id<'SellerCategory'>): Promise<ShelfView | null>;

  /** One seller's shelves in every status, active first. */
  shelvesOfSeller(market: MarketContext, sellerId: Id<'Seller'>): Promise<readonly ShelfView[]>;

  /**
   * Closes an active shelf (promoted or merged) from `expectedVersion`; false when it is no
   * longer active at that version.
   */
  closeShelf(
    market: MarketContext,
    id: Id<'SellerCategory'>,
    expectedVersion: number,
    close:
      | { readonly status: 'promoted' }
      | { readonly status: 'merged'; readonly into: Id<'Category'> },
  ): Promise<boolean>;

  /**
   * Clears the shelf on every Offer that carries it, each with its version raised and an
   * `offer_history` row `shelf-cleared`; answers how many Offers.
   */
  clearShelfOnOffers(
    market: MarketContext,
    shelfId: Id<'SellerCategory'>,
    actor: ShelfActor,
    now: Temporal.Instant,
  ): Promise<number>;

  /**
   * Sets or clears the shelf of one Offer of the seller (not deleted), raising its version and
   * writing an `offer_history` row; `offer.not-found` for another seller's or an unknown Offer,
   * `conflict.stale` when the version differs.
   */
  setOfferShelf(
    market: MarketContext,
    change: {
      readonly offerId: Id<'Offer'>;
      readonly sellerId: Id<'Seller'>;
      readonly shelfId: Id<'SellerCategory'> | null;
      readonly expectedVersion: number;
      readonly actor: ShelfActor;
      readonly now: Temporal.Instant;
    },
  ): Promise<{ readonly version: number } | 'offer.not-found' | 'conflict.stale'>;

  /** Whether the platform category exists in the Market and is live (active or hidden). */
  platformParentState(
    market: MarketContext,
    id: Id<'Category'>,
  ): Promise<{ readonly status: string } | null>;
}

export const SELLER_CATEGORY_STORE = Symbol('SELLER_CATEGORY_STORE');
