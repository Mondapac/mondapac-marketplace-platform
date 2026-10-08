import { defineEvent, eventField } from '@mondapac/shared-kernel';
import type { EventDefinition } from '@mondapac/shared-kernel';

// The events pricing publishes (pricing design 6.3; platform persistence design 5.3): ids, enums
// and instants only. No amount travels in any event (the vocabulary has no money kind; consumers
// read the facade), no Cost, and no actor (ADR-0018 decision 4). Every new or changed type
// changes the checked-in catalogue snapshot (`test/contracts/event-catalogue.snapshot.json`),
// the only check of the "no amount" rule (pricing design 13; Hassan, pricing-data review).

/** The aggregate type of every pricing event (pricing design 6.3). */
export const PRICE_SERIES_AGGREGATE = 'price-series';

/**
 * Why the effective price of a key changed (pricing design 6.3). The list is frozen once the
 * first consumer of the event is merged: a later cause is a `.v2`, never a new value here (Ali).
 */
export const EFFECTIVE_PRICE_CAUSES = [
  'regular-accepted',
  'hold-approved',
  'special-started',
  'special-ended',
  'special-withdrawn',
  'series-retired',
  'series-rekeyed',
] as const;
export type EffectivePriceCause = (typeof EFFECTIVE_PRICE_CAUSES)[number];

export const PRICE_RECORD_KINDS = ['regular', 'special'] as const;
export const HOLD_DIRECTIONS = ['up', 'down'] as const;
export const HOLD_OUTCOMES = ['approved', 'rejected', 'superseded'] as const;

/**
 * The effective price of (Offer, Variant) changed, or will at `effectiveFrom` (pricing design
 * 6.3). `previousProductId` and `previousVariantId` are set for `series-rekeyed` only, and null
 * otherwise (Ali).
 */
export const EffectivePriceChanged = defineEvent({
  type: 'pricing.effective-price-changed.v1',
  aggregateType: PRICE_SERIES_AGGREGATE,
  payload: {
    offerId: eventField.id(),
    variantId: eventField.id(),
    cause: eventField.enumOf(EFFECTIVE_PRICE_CAUSES),
    effectiveFrom: eventField.instant(),
    previousProductId: eventField.optional(eventField.id()),
    previousVariantId: eventField.optional(eventField.id()),
  },
});

/** A price was held for review (pricing design 3.1 row 2, 3.2 row 2). */
export const PriceHoldOpened = defineEvent({
  type: 'pricing.price-hold-opened.v1',
  aggregateType: PRICE_SERIES_AGGREGATE,
  payload: {
    offerId: eventField.id(),
    variantId: eventField.id(),
    recordId: eventField.id(),
    kind: eventField.enumOf(PRICE_RECORD_KINDS),
    direction: eventField.enumOf(HOLD_DIRECTIONS),
  },
});

/**
 * A held price left review: approved, rejected, or superseded by a new seller write, a cancel,
 * or the retirement of its series (pricing design 3.1 rows 3 to 5).
 */
export const PriceHoldDecided = defineEvent({
  type: 'pricing.price-hold-decided.v1',
  aggregateType: PRICE_SERIES_AGGREGATE,
  payload: {
    offerId: eventField.id(),
    variantId: eventField.id(),
    recordId: eventField.id(),
    kind: eventField.enumOf(PRICE_RECORD_KINDS),
    outcome: eventField.enumOf(HOLD_OUTCOMES),
  },
});

/** Every event pricing publishes, registered with the event catalogue by `PricingModule`. */
export const PRICING_EVENTS: readonly EventDefinition[] = [
  EffectivePriceChanged,
  PriceHoldOpened,
  PriceHoldDecided,
];
