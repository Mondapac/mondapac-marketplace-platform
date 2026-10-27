import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { DisputeBucket, DisputeCase, DisputeDecision } from '../../domain/dispute';

/** One page of the admin list: newest opened first; the cursor is the last row of the page. */
export interface DisputePage {
  readonly bucket: DisputeBucket | null;
  readonly limit: number;
  readonly after: { readonly openedAt: Temporal.Instant; readonly disputeId: Id<'Dispute'> } | null;
}

export interface SellerOrderRef {
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly orderId: Id<'Order'>;
}

/**
 * The dispute cases and the admin's decisions of one Market (`commission_payouts.dispute_cases`
 * and `dispute_decisions`). A case is a snapshot refreshed from payments; a decision is insert-only
 * (a trigger refuses any change). Runs inside the caller's unit of work.
 */
export interface DisputeRepository {
  find(market: MarketContext, disputeId: Id<'Dispute'>): Promise<DisputeCase | null>;

  /** Inserts a new case; false when it exists already (a concurrent first sight). */
  insert(market: MarketContext, dispute: DisputeCase): Promise<boolean>;

  /**
   * Overwrites the state of a case with the newer one: applies only while the stored synced
   * version is not above `next.lastSyncedVersion`. False when it did not apply.
   */
  refresh(market: MarketContext, next: DisputeCase): Promise<boolean>;

  /** Sets the list bucket after a decision. */
  setBucket(
    market: MarketContext,
    disputeId: Id<'Dispute'>,
    bucket: DisputeBucket,
    now: Temporal.Instant,
  ): Promise<void>;

  list(market: MarketContext, page: DisputePage): Promise<readonly DisputeCase[]>;

  /** The number of cases per bucket (buckets with none are absent). */
  counts(market: MarketContext): Promise<ReadonlyMap<DisputeBucket, number>>;

  findMany(
    market: MarketContext,
    disputeIds: readonly Id<'Dispute'>[],
  ): Promise<readonly DisputeCase[]>;

  /** The seller orders of an order, from this module's own ledger rows. */
  sellerOrdersOfOrder(
    market: MarketContext,
    orderId: Id<'Order'>,
  ): Promise<readonly SellerOrderRef[]>;

  /** The same for several orders (the list page). */
  sellerOrdersOfOrders(
    market: MarketContext,
    orderIds: readonly Id<'Order'>[],
  ): Promise<readonly SellerOrderRef[]>;

  /**
   * Serialises the admin decisions that touch one dispute or one seller order: locks the case row
   * `FOR UPDATE`, then takes the seller order's advisory lock (always in this order, so no
   * deadlock). Call it first in the unit, before any read the decision depends on. False when the
   * case does not exist.
   */
  lockForDecision(
    market: MarketContext,
    disputeId: Id<'Dispute'>,
    sellerOrderId: Id<'SellerOrder'>,
  ): Promise<boolean>;

  /**
   * Locks the case row `FOR UPDATE` (the same lock {@link lockForDecision} takes first), so a sync
   * reads the decisions after any decision in flight has committed. False when there is no case
   * yet (the sync then inserts it).
   */
  lockCase(market: MarketContext, disputeId: Id<'Dispute'>): Promise<boolean>;

  decisionsOf(market: MarketContext, disputeId: Id<'Dispute'>): Promise<readonly DisputeDecision[]>;

  decisionsForSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<readonly DisputeDecision[]>;

  /** Inserts a decision; false on a unique clash (a first decision or a reversal already there). */
  insertDecision(market: MarketContext, decision: DisputeDecision): Promise<boolean>;
}

export const DISPUTE_REPOSITORY = Symbol('COMMISSION_PAYOUTS_DISPUTE_REPOSITORY');
