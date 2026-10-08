import { defineEvent, eventField } from '@mondapac/shared-kernel';
import type { EventDefinition } from '@mondapac/shared-kernel';

// The events inventory publishes (inventory design 7.3; platform persistence design 5.3): ids,
// enums and integers only. Consumers treat both as signals, not truth (brief s6). No actor and no
// reservation event: `ordering` gets synchronous answers. A new or changed type changes the
// checked-in catalogue snapshot (`test/contracts/event-catalogue.snapshot.json`).

/** The aggregate type of every inventory event (data design 3.1). */
export const AVAILABILITY_SIGNAL_AGGREGATE = 'availability-signal';

/** The public status of a sell unit (design 5.2). */
export const AVAILABILITY_STATUSES = ['in-stock', 'low', 'out'] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

/**
 * The status or `onlyLeft` of a sell unit changed (design 5.3). `onlyLeft` is set for `low` only.
 * The aggregate version is the signal's version, so a consumer can drop a stale event.
 */
export const AvailabilityChanged = defineEvent({
  type: 'inventory.availability-changed.v1',
  aggregateType: AVAILABILITY_SIGNAL_AGGREGATE,
  payload: {
    offerId: eventField.id(),
    variantId: eventField.id(),
    status: eventField.enumOf(AVAILABILITY_STATUSES),
    onlyLeft: eventField.optional(eventField.integer()),
  },
});

/** A sell unit first entered `low` from `in-stock` (design 5.3): for the seller's notification. */
export const LowStockReached = defineEvent({
  type: 'inventory.low-stock-reached.v1',
  aggregateType: AVAILABILITY_SIGNAL_AGGREGATE,
  payload: {
    sellerId: eventField.id(),
    offerId: eventField.id(),
    variantId: eventField.id(),
    onlyLeft: eventField.integer(),
  },
});

/** Every event inventory publishes, registered with the event catalogue by `InventoryModule`. */
export const INVENTORY_EVENTS: readonly EventDefinition[] = [AvailabilityChanged, LowStockReached];
