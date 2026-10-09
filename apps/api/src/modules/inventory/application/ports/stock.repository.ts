import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** One stock item as the rules read it (data design 3.4). */
export interface StockItemRow {
  readonly id: Id<'StockItem'>;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly sourceId: Id<'InventorySource'>;
  readonly sellerId: Id<'Seller'>;
  readonly onHand: number;
  readonly retired: boolean;
  readonly version: number;
}

export interface NewStockItem {
  readonly id: Id<'StockItem'>;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly sourceId: Id<'InventorySource'>;
  readonly sellerId: Id<'Seller'>;
  readonly onHand: number;
  readonly createdAt: Temporal.Instant;
}

/** One ledger entry of an account's stock write (data design 3.5). */
export interface NewStockMovement {
  readonly id: Id<'StockMovement'>;
  readonly stockItemId: Id<'StockItem'>;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly delta: number;
  readonly resultingOnHand: number;
  readonly reason: 'seller-set';
  readonly actorAccountId: Id<'Account'>;
  readonly correlationId: string;
  readonly occurredAt: Temporal.Instant;
}

/** What a catalog retirement covers: an Offer, or a Variant across every Offer (data design 3.10). */
export type RetirementTarget =
  | { readonly scope: 'offer'; readonly offerId: Id<'Offer'> }
  | { readonly scope: 'variant'; readonly variantId: Id<'Variant'> };

export interface NewRetirementTombstone {
  readonly id: Id<'Retirement'>;
  readonly target: RetirementTarget;
  /** The `aggregateVersion` of the catalog event; kept for audit only. */
  readonly sourceAggregateVersion: number;
  readonly retiredAt: Temporal.Instant;
}

/**
 * The store of stock items and their ledger (data design 3.4, 3.5, 4.3, 4.4). Every method runs in
 * the open unit of the use case; the writers run only in a `serializable` unit (4.5).
 */
export interface StockRepository {
  /**
   * Every stock item of the sell unit, retired ones included, locked `FOR NO KEY UPDATE` in
   * ascending id order by the named statement `inventory.lock-stock-items` (lock rule L1). Empty
   * when the sell unit has no item yet: there is nothing to lock, and the unique key plus the
   * serializable unit settle a creation race.
   */
  lockSellUnit(
    market: MarketContext,
    offerId: Id<'Offer'>,
    variantId: Id<'Variant'>,
  ): Promise<readonly StockItemRow[]>;

  /** True when a catalog retirement tombstone covers the Offer or the Variant (data design 3.10). */
  isSellUnitRetired(
    market: MarketContext,
    offerId: Id<'Offer'>,
    variantId: Id<'Variant'>,
  ): Promise<boolean>;

  /**
   * The quantity held on each item by active reservations and committed lines (design 4.1),
   * 0 for an item with none. Reservations arrive with slice 4 and this body then counts them; until
   * then the table does not exist, so nothing can be held.
   */
  /**
   * The ids of the target's items that are not retired, in ascending id order (read through the
   * active index, data design 3.4). A plain read: the caller locks them with {@link lockItems}.
   */
  activeItemIds(
    market: MarketContext,
    target: RetirementTarget,
  ): Promise<readonly Id<'StockItem'>[]>;

  /**
   * Locks the items `FOR NO KEY UPDATE` with the named statement `inventory.lock-stock-items`, in
   * ascending id order. More than its 1,000-id cap are locked in consecutive ascending batches of
   * one unit, so the global order stays ascending (data design 4.4, 4.3). Serializable unit only.
   */
  lockItems(
    market: MarketContext,
    ids: readonly Id<'StockItem'>[],
  ): Promise<readonly StockItemRow[]>;

  /** Records the tombstone; an existing one for the same key is left as it is. Serializable only. */
  recordTombstone(market: MarketContext, tombstone: NewRetirementTombstone): Promise<void>;

  /**
   * Sets `retired_at` on the given items that are not retired yet, one way, and answers how many
   * it changed. The caller holds their locks. Serializable unit only.
   */
  retireItems(
    market: MarketContext,
    ids: readonly Id<'StockItem'>[],
    retiredAt: Temporal.Instant,
  ): Promise<number>;

  heldQuantities(
    market: MarketContext,
    stockItemIds: readonly Id<'StockItem'>[],
  ): Promise<ReadonlyMap<Id<'StockItem'>, number>>;

  insertItem(market: MarketContext, item: NewStockItem): Promise<void>;

  /**
   * Sets `onHand` and raises the version by one, only if the stored version is
   * `expectedVersion`; otherwise writes nothing and answers `stale`.
   */
  setOnHand(
    market: MarketContext,
    id: Id<'StockItem'>,
    expectedVersion: number,
    onHand: number,
  ): Promise<'saved' | 'stale'>;

  appendMovement(market: MarketContext, movement: NewStockMovement): Promise<void>;
}

export const STOCK_REPOSITORY = Symbol('STOCK_REPOSITORY');
