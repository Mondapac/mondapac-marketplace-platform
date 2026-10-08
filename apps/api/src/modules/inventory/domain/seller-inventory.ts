import type { Id, MarketId, Temporal } from '@mondapac/shared-kernel';

/**
 * The name of the Default source a new seller inventory starts with (inventory design 3.4). A
 * stored text, not a translation key: the seller may rename it (a later slice), and the panel
 * marks the Default source with its own badge.
 */
export const DEFAULT_SOURCE_NAME = 'Default';

/** One place a seller keeps stock (inventory design 2.1), a child of the seller inventory. */
export interface InventorySourceState {
  readonly id: Id<'InventorySource'>;
  readonly name: string;
  /** Set at creation, never changed (data design 3.3). */
  readonly isDefault: boolean;
  /** Position 1..n in the seller's order (Q9). */
  readonly priority: number;
  readonly createdAt: Temporal.Instant;
}

export interface SellerInventoryState {
  readonly id: Id<'SellerInventory'>;
  readonly sellerId: Id<'Seller'>;
  readonly marketId: MarketId;
  /** The seller's override; null means the Market default (inventory design 5.2). */
  readonly lowStockThreshold: number | null;
  readonly version: number;
  readonly createdAt: Temporal.Instant;
  readonly sources: readonly InventorySourceState[];
}

/**
 * The inventory of one seller in one Market (inventory design 2.1, 3.4; SEL-10): the root of the
 * seller's sources. Slice 1 holds what the approval handler creates: the inventory with exactly
 * one Default source at priority 1, which starts without an address or zone (Q-H2: the seller's
 * zone is implied). Adding, renaming and reordering sources arrive in the next part of the slice.
 */
export class SellerInventory {
  readonly #state: SellerInventoryState;

  private constructor(state: SellerInventoryState) {
    this.#state = Object.freeze({ ...state, sources: Object.freeze([...state.sources]) });
  }

  static createWithDefaultSource(input: {
    readonly id: Id<'SellerInventory'>;
    readonly defaultSourceId: Id<'InventorySource'>;
    readonly sellerId: Id<'Seller'>;
    readonly marketId: MarketId;
    readonly now: Temporal.Instant;
  }): SellerInventory {
    return new SellerInventory({
      id: input.id,
      sellerId: input.sellerId,
      marketId: input.marketId,
      lowStockThreshold: null,
      version: 1,
      createdAt: input.now,
      sources: [
        Object.freeze({
          id: input.defaultSourceId,
          name: DEFAULT_SOURCE_NAME,
          isDefault: true,
          priority: 1,
          createdAt: input.now,
        }),
      ],
    });
  }

  get state(): SellerInventoryState {
    return this.#state;
  }
}
