import type { CallContext, Id, Money } from '@mondapac/shared-kernel';

/** One sell unit (Offer, Variant) the index asks about. */
export interface SellUnitRef {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
}

/** The map key of a {@link SellUnitRef}. */
export const sellUnitRefKey = (ref: SellUnitRef): string => `${ref.offerId}/${ref.variantId}`;

/** What the index keeps of a sell unit (variants V8): never the exact stock count. */
export interface SellUnitState {
  /** Inventory's public status is `in-stock` or `low`. */
  readonly inStock: boolean;
  /** Pricing's effective price now, or null when none is in force. */
  readonly price: Money | null;
}

/**
 * The stock and price of sell units, from inventory's and pricing's facades, called with the
 * caller's context unchanged (the indexer runs as the system actor). Keyed by
 * {@link sellUnitRefKey}; a unit either source does not answer is out of stock and unpriced. A
 * refusal or failure of either is `null`: the caller throws and the delivery is retried.
 */
export interface SellUnitStates {
  states(
    context: CallContext,
    units: readonly SellUnitRef[],
  ): Promise<ReadonlyMap<string, SellUnitState> | null>;
}

export const SELL_UNIT_STATES = Symbol('SELL_UNIT_STATES');
