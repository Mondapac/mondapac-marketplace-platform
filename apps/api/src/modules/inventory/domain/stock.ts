import type { Id, PendingEvent, Temporal } from '@mondapac/shared-kernel';
import { AvailabilityChanged, LowStockReached, type AvailabilityStatus } from './events';

// The pure rules of stock levels and the availability signal (inventory design 2.1, 4.1, 5.2,
// 5.3). No clock, no storage: the use case passes the instant and the stored state.

/** The largest level a stock item can hold: the `integer` column (data design 3.4). */
export const MAX_STOCK_LEVEL = 2_147_483_647;

/** A stock level (Q6): a whole number from 0 to {@link MAX_STOCK_LEVEL}; anything else is null. */
export function parseStockLevel(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) return null;
  return raw >= 0 && raw <= MAX_STOCK_LEVEL ? raw : null;
}

/** The part of a stock item the rules read. */
export interface StockLevelView {
  readonly onHand: number;
  readonly retired: boolean;
}

/**
 * Sellable quantity of one source: `max(0, onHand - held)` (design 4.1). `held` is the active
 * reservations plus the committed lines on the item, as the repository counts them.
 */
export function sellableOf(onHand: number, held: number): number {
  return Math.max(0, onHand - held);
}

/**
 * The sellable quantity of a sell unit: the largest sellable of its non-retired sources (Q10).
 * No item, or only retired ones, is 0 (fail closed, design 5.2).
 */
export function sellableOfSellUnit(
  items: readonly { readonly onHand: number; readonly held: number; readonly retired: boolean }[],
): number {
  let best = 0;
  for (const item of items) {
    if (!item.retired) best = Math.max(best, sellableOf(item.onHand, item.held));
  }
  return best;
}

/** The public status of a sell unit and the count shown with `low` (design 5.2). */
export interface Availability {
  readonly status: AvailabilityStatus;
  /** Set for `low` only. */
  readonly onlyLeft: number | null;
}

/**
 * `out` when nothing is sellable; `low` with `onlyLeft` when it is at most the threshold; else
 * `in-stock` (AC 7: threshold 5, sellable 4 is low 4; sellable 7 is in stock). A threshold of 0
 * never shows a count.
 */
export function availabilityOf(sellable: number, threshold: number): Availability {
  if (sellable <= 0) return { status: 'out', onlyLeft: null };
  if (sellable <= threshold) return { status: 'low', onlyLeft: sellable };
  return { status: 'in-stock', onlyLeft: null };
}

/** The stored signal of a sell unit (data design 3.9). */
export interface StoredSignal {
  readonly id: Id<'AvailabilitySignal'>;
  readonly status: AvailabilityStatus;
  readonly onlyLeft: number | null;
  readonly version: number;
}

/** What a recompute decided: nothing, or the new signal and the events that record it. */
export type SignalChange =
  | { readonly kind: 'unchanged' }
  | {
      readonly kind: 'changed';
      readonly created: boolean;
      readonly next: Availability;
      /** The version after the change: the aggregate version of the last event. */
      readonly version: number;
      readonly events: readonly PendingEvent[];
    };

export interface SignalInput {
  /** The stored signal, or null when the sell unit has none yet. */
  readonly stored: StoredSignal | null;
  /** The id a new signal takes (the aggregate id of its events). */
  readonly newId: Id<'AvailabilitySignal'>;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly sellerId: Id<'Seller'>;
  readonly next: Availability;
  readonly now: Temporal.Instant;
}

/**
 * Decides whether the signal changes and builds its events (design 5.3). Changed only when the
 * status or `onlyLeft` differs from the stored signal; a sell unit with no signal yet gets one
 * at version 1 (its first event). Each event takes the next version, so the outbox's unique
 * `(aggregate, version)` holds and the stored version equals the last event's. The first entry
 * into `low` from `in-stock` adds `inventory.low-stock-reached.v1` after the change event.
 */
export function recomputeSignal(input: SignalInput): SignalChange {
  const { stored, next } = input;
  if (stored !== null && stored.status === next.status && stored.onlyLeft === next.onlyLeft) {
    return { kind: 'unchanged' };
  }
  const aggregateId = stored?.id ?? input.newId;
  let version = stored?.version ?? 0;
  const events: PendingEvent[] = [];
  version += 1;
  events.push(
    AvailabilityChanged.record({
      aggregateId,
      aggregateVersion: version,
      occurredAt: input.now,
      payload: {
        offerId: input.offerId,
        variantId: input.variantId,
        status: next.status,
        onlyLeft: next.onlyLeft,
      },
    }),
  );
  if (stored !== null && stored.status === 'in-stock' && next.status === 'low') {
    version += 1;
    events.push(
      LowStockReached.record({
        aggregateId,
        aggregateVersion: version,
        occurredAt: input.now,
        payload: {
          sellerId: input.sellerId,
          offerId: input.offerId,
          variantId: input.variantId,
          onlyLeft: next.onlyLeft as number,
        },
      }),
    );
  }
  return { kind: 'changed', created: stored === null, next, version, events };
}
