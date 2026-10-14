import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { ReleaseCause, Reservation, ReservationLineStatus } from '../../domain/reservation';
import type { StockItemRow } from './stock.repository';

export interface SellUnitRef {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
}

/** One line looked up by its order line (the idempotency key of cancel and shipment). */
export interface CommittedLineRow {
  readonly lineId: Id<'ReservationLine'>;
  readonly reservationId: Id<'Reservation'>;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly stockItemId: Id<'StockItem'>;
  readonly quantity: number;
  readonly status: ReservationLineStatus;
}

/** Where one reservation line lands when the reservation is committed. */
export interface CommitAssignment {
  readonly lineId: Id<'ReservationLine'>;
  readonly orderLineId: string;
  readonly stockItemId: Id<'StockItem'>;
}

/**
 * The store of reservations, their lines and the per-Offer purchase limits, with the stock reads
 * a reservation unit needs (data design 3.6 to 3.8, 4.3, 4.4). Every method runs in the open unit
 * of the use case, READ COMMITTED; the lock comes first (lock rules L1 to L4).
 */
export interface ReservationRepository {
  /** Every stock item of the sell units, retired ones included, in ascending id order. A plain read. */
  itemsOfSellUnits(
    market: MarketContext,
    keys: readonly SellUnitRef[],
  ): Promise<readonly StockItemRow[]>;

  /**
   * Locks the items `FOR NO KEY UPDATE` with the named statement `inventory.lock-stock-items`, in
   * ascending id order, in one call (data design 4.3). More than the statement's cap is a bug of
   * the caller: it throws.
   */
  lockItems(
    market: MarketContext,
    ids: readonly Id<'StockItem'>[],
  ): Promise<readonly StockItemRow[]>;

  /**
   * Raises `hold_seq` (not `version`) on locked items whose holds this unit changes. `lockItems`
   * already does it for its own set; the rekey, which locks through the stock repository, calls
   * it itself. A SERIALIZABLE stock unit that locks such a row later gets 40001 and retries.
   */
  markHoldsChanged(market: MarketContext, ids: readonly Id<'StockItem'>[]): Promise<void>;

  /**
   * Units held on each item at `now`: ACTIVE lines not yet expired plus COMMITTED lines, 0 for an
   * item with none (data design 4.3). A new statement, so it sees every commit before the lock.
   */
  heldQuantities(
    market: MarketContext,
    ids: readonly Id<'StockItem'>[],
    now: Temporal.Instant,
  ): Promise<ReadonlyMap<Id<'StockItem'>, number>>;

  /** The seller's per-customer limit of each Offer that has one. */
  purchaseLimits(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, number>>;

  /** The holder's ACTIVE reservation (expired or not) with its lines, or null. */
  findActiveByHolder(
    market: MarketContext,
    holderAccountId: Id<'Account'>,
  ): Promise<Reservation | null>;

  findById(market: MarketContext, id: Id<'Reservation'>): Promise<Reservation | null>;

  /**
   * Inserts the header and its lines. Answers `holder-conflict` and writes nothing when another
   * ACTIVE reservation of the holder got in first (the partial unique key, data design 3.6): the
   * caller maps it to `conflict.retry`.
   */
  insert(market: MarketContext, reservation: Reservation): Promise<'inserted' | 'holder-conflict'>;

  /**
   * ACTIVE to RELEASED for the header and its lines, guarded on `status = 'active'`: answers false
   * and changes nothing when another unit already moved it.
   */
  releaseActive(
    market: MarketContext,
    id: Id<'Reservation'>,
    cause: ReleaseCause,
    now: Temporal.Instant,
  ): Promise<boolean>;

  /**
   * ACTIVE, EXPIRED or RELEASED-as-superseded to COMMITTED, guarded on that status: answers false
   * and changes nothing when another unit moved it first. The lines get their order line, their
   * (possibly new) stock item and the state `committed`. The release cause `superseded` is kept.
   */
  commit(
    market: MarketContext,
    id: Id<'Reservation'>,
    assignments: readonly CommitAssignment[],
    now: Temporal.Instant,
  ): Promise<boolean>;

  /** The line that carries this order line, or null. */
  findLineByOrderLine(market: MarketContext, orderLineId: string): Promise<CommittedLineRow | null>;

  /** COMMITTED to `to`, guarded on `state = 'committed'`; answers false when it was not. */
  finishLine(
    market: MarketContext,
    lineId: Id<'ReservationLine'>,
    to: 'cancelled' | 'fulfilled',
    now: Temporal.Instant,
  ): Promise<boolean>;

  /**
   * Takes `quantity` off the item's on-hand and raises its version (a shipment, design 3.2).
   * Answers the new on-hand, or null when the item holds less (nothing is written then). Runs
   * under the item's lock.
   */
  shipUnits(market: MarketContext, id: Id<'StockItem'>, quantity: number): Promise<number | null>;

  /**
   * Deletes up to `limit` RELEASED or EXPIRED reservations whose last status change is before
   * `before` (their lines go by the cascade); answers how many. Takes no stock lock: no sum reads
   * these rows (design 4.3, 11).
   */
  pruneTerminal(market: MarketContext, before: Temporal.Instant, limit: number): Promise<number>;

  /**
   * ACTIVE to EXPIRED for the given reservations, guarded on `status = 'active'` and
   * `expires_at <= now`; answers the ids it changed.
   */
  expireDue(
    market: MarketContext,
    ids: readonly Id<'Reservation'>[],
    now: Temporal.Instant,
  ): Promise<readonly Id<'Reservation'>[]>;

  /** At most `limit` ACTIVE reservations past their expiry, oldest first, with their lines. No lock. */
  dueForExpiry(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly Reservation[]>;

  /**
   * The ACTIVE, unexpired reservations that hold a line on one of the sell units, with all their
   * lines (the re-key's release, design 3.6 step 4). No lock.
   */
  liveOnSellUnits(
    market: MarketContext,
    keys: readonly SellUnitRef[],
    now: Temporal.Instant,
  ): Promise<readonly Reservation[]>;
}

export const RESERVATION_REPOSITORY = Symbol('RESERVATION_REPOSITORY');
