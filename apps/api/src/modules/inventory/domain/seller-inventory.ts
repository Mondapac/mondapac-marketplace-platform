import {
  err,
  ok,
  type Id,
  type MarketId,
  type Result,
  type Temporal,
} from '@mondapac/shared-kernel';
import type { SourceAddress } from './source-text';

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
  /** Personal data (a sole trader's home); null on the Default source until the seller adds one. */
  readonly address: SourceAddress | null;
  /** An IANA zone id, or null: the seller's own zone (ADR-0005 decision 2). */
  readonly timeZone: string | null;
  readonly createdAt: Temporal.Instant;
}

/** What a mutation changed, for the repository to write (inventory data design 3.3, T2). */
export type SourceChange =
  | { readonly kind: 'added'; readonly sourceId: Id<'InventorySource'> }
  | { readonly kind: 'edited'; readonly sourceId: Id<'InventorySource'> }
  | { readonly kind: 'reordered' };

export type LimitReached = {
  readonly code: 'inventory.sources.limit-reached';
  readonly max: number;
};
export type SourceNotFound = { readonly code: 'inventory.source.not-found' };
export type OrderMismatch = { readonly code: 'inventory.sources.order-mismatch' };

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
 * zone is implied). Part 2 adds the seller's own changes: append a source, edit one, set the order. Each change
 * raises the inventory's `version` by one (data design C5, D 2.3).
 */
export class SellerInventory {
  readonly #state: SellerInventoryState;
  /** The version the store held when this aggregate was loaded; null for a new one. */
  readonly #persistedVersion: number | null;
  readonly #changes: readonly SourceChange[];

  private constructor(
    state: SellerInventoryState,
    persistedVersion: number | null,
    changes: readonly SourceChange[],
  ) {
    this.#state = Object.freeze({ ...state, sources: Object.freeze([...state.sources]) });
    this.#persistedVersion = persistedVersion;
    this.#changes = Object.freeze([...changes]);
  }

  /** Rebuilds a stored inventory (repository only); its `version` is the persisted one. */
  static fromStored(state: SellerInventoryState): SellerInventory {
    return new SellerInventory(state, state.version, []);
  }

  static createWithDefaultSource(input: {
    readonly id: Id<'SellerInventory'>;
    readonly defaultSourceId: Id<'InventorySource'>;
    readonly sellerId: Id<'Seller'>;
    readonly marketId: MarketId;
    readonly now: Temporal.Instant;
  }): SellerInventory {
    return new SellerInventory(
      {
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
            address: null,
            timeZone: null,
            createdAt: input.now,
          }),
        ],
      },
      null,
      [],
    );
  }

  /**
   * Appends a source last (inventory design 3.4). Refused when the seller already has `max`
   * sources, the Default included.
   */
  addSource(input: {
    readonly id: Id<'InventorySource'>;
    readonly name: string;
    readonly address: SourceAddress | null;
    readonly timeZone: string | null;
    readonly maxSources: number;
    readonly now: Temporal.Instant;
  }): Result<SellerInventory, LimitReached> {
    const sources = this.#state.sources;
    if (sources.length >= input.maxSources) {
      return err({ code: 'inventory.sources.limit-reached', max: input.maxSources });
    }
    const added: InventorySourceState = Object.freeze({
      id: input.id,
      name: input.name,
      isDefault: false,
      priority: sources.length + 1,
      address: input.address,
      timeZone: input.timeZone,
      createdAt: input.now,
    });
    return ok(this.next([...sources, added], [{ kind: 'added', sourceId: input.id }]));
  }

  /**
   * Changes a source's name, address and zone (the Default may be renamed, never removed or
   * replaced). A save that changes nothing returns this aggregate unchanged.
   */
  editSource(input: {
    readonly sourceId: Id<'InventorySource'>;
    readonly name: string;
    readonly address: SourceAddress | null;
    readonly timeZone: string | null;
  }): Result<SellerInventory, SourceNotFound> {
    const current = this.#state.sources.find((source) => source.id === input.sourceId);
    if (current === undefined) return err({ code: 'inventory.source.not-found' });
    if (
      current.name === input.name &&
      current.timeZone === input.timeZone &&
      JSON.stringify(current.address) === JSON.stringify(input.address)
    ) {
      return ok(this);
    }
    const edited: InventorySourceState = Object.freeze({
      ...current,
      name: input.name,
      address: input.address,
      timeZone: input.timeZone,
    });
    return ok(
      this.next(
        this.#state.sources.map((source) => (source.id === input.sourceId ? edited : source)),
        [{ kind: 'edited', sourceId: input.sourceId }],
      ),
    );
  }

  /**
   * Sets the order of every source (Q9): `orderedIds` must name each of the seller's sources
   * exactly once; positions become 1..n in that order. The same order returns this aggregate
   * unchanged.
   */
  reorder(orderedIds: readonly Id<'InventorySource'>[]): Result<SellerInventory, OrderMismatch> {
    const sources = this.#state.sources;
    const byId = new Map(sources.map((source) => [source.id as string, source]));
    if (
      orderedIds.length !== sources.length ||
      new Set(orderedIds).size !== orderedIds.length ||
      orderedIds.some((id) => !byId.has(id))
    ) {
      return err({ code: 'inventory.sources.order-mismatch' });
    }
    const reordered = orderedIds.map((id, index) =>
      Object.freeze({ ...byId.get(id)!, priority: index + 1 }),
    );
    if (reordered.every((source, index) => source.id === sources[index]!.id)) return ok(this);
    return ok(this.next(reordered, [{ kind: 'reordered' }]));
  }

  private next(
    sources: readonly InventorySourceState[],
    changes: readonly SourceChange[],
  ): SellerInventory {
    return new SellerInventory(
      { ...this.#state, version: this.#state.version + 1, sources },
      this.#persistedVersion,
      [...this.#changes, ...changes],
    );
  }

  /** The version the store held at load; null for an inventory not stored yet. */
  get persistedVersion(): number | null {
    return this.#persistedVersion;
  }

  /** What changed since load, in order, for the repository to write. */
  get changes(): readonly SourceChange[] {
    return this.#changes;
  }

  get state(): SellerInventoryState {
    return this.#state;
  }
}
