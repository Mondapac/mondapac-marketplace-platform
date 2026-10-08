import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import type { AuditActionDefinition } from '@mondapac/shared-kernel';
import { HOLD_DIRECTIONS } from '../events';

// The audited actions of pricing (pricing design 8; platform-audit 3.2), registered at boot with
// `registerAuditActions('pricing', PRICING_AUDIT_ACTIONS)` and written through pricing's own
// AUDIT_WRITER in the unit of the change. Ids, codes and instants only. Every new or changed
// action changes the checked-in catalogue snapshot, for the security review.
//
// Amounts: design 8 lists the regular and anchor amounts on `.accepted` and `.held`; they use the
// kernel's `money` kind (platform-audit 3.2). Only regular prices are audited here: Cost never
// appears in an audit row of this module (ADR-0024; the catalogue contract test checks it).
//
// Slice 1, part 3b: the seller's regular-price write and its refusals. Later parts add the
// decisions (slice 4), the retirement and re-key rows (system actor) and Cost (slice 3).

/** The audit target type of a price series (PA 4). */
export const PRICE_SERIES_TARGET = 'pricing.price-series';

/** Why a pending regular record was superseded (pricing-data 3.3, M6). */
export const SUPERSEDE_CAUSES = [
  'replaced',
  'cancelled',
  'offer-removed',
  'variant-removed',
] as const;

/**
 * Why a seller's write answered `pricing.offer-not-found` (design 5.2, 8; Hassan finding 2),
 * kept inside the row only and never in the answer. `absent` covers an id of another Market:
 * catalog answers only for the context's Market, so the two cannot be told apart (and must not
 * be). `key-retired`: catalog's advisory answer was stale and a retirement tombstone refused the
 * creation of the series (design 5.2, 6.4).
 */
export const OFFER_WRITE_REFUSAL_CAUSES = [
  'absent',
  'not-yours',
  'deleted',
  'variant-not-priceable',
  'key-retired',
] as const;
export type OfferWriteRefusalCause = (typeof OFFER_WRITE_REFUSAL_CAUSES)[number];

/** A seller's regular price became effective without review (design 3.1 row 1). */
export const RegularPriceAccepted = defineAuditAction({
  action: 'pricing.regular-price.accepted',
  targetType: PRICE_SERIES_TARGET,
  actors: ['authenticated'],
  after: {
    offerId: auditField.id(),
    variantId: auditField.id(),
    recordId: auditField.id(),
    amount: auditField.money(),
    /** Null for the first price of a series, which is never measured. */
    anchorRecordId: auditField.optional(auditField.id()),
    anchorAmount: auditField.optional(auditField.money()),
    /** The record whose effective period this one closed; null for the first price. */
    previousRecordId: auditField.optional(auditField.id()),
    effectiveFrom: auditField.instant(),
  },
});

/** A seller's regular price was held for review (design 3.1 row 2). */
export const RegularPriceHeld = defineAuditAction({
  action: 'pricing.regular-price.held',
  targetType: PRICE_SERIES_TARGET,
  actors: ['authenticated'],
  after: {
    offerId: auditField.id(),
    variantId: auditField.id(),
    recordId: auditField.id(),
    amount: auditField.money(),
    anchorRecordId: auditField.id(),
    anchorAmount: auditField.money(),
    direction: auditField.enumOf(HOLD_DIRECTIONS),
  },
});

/**
 * A pending regular record was superseded (design 3.1 row 5): by a new seller write
 * (`replaced`, naming the successor) or a write equal to the price in force (`cancelled`). The
 * retirement causes are written by the retirement handlers (system actor), which add `system`
 * to `actors` when they ship.
 */
export const RegularPriceSuperseded = defineAuditAction({
  action: 'pricing.regular-price.superseded',
  targetType: PRICE_SERIES_TARGET,
  actors: ['authenticated'],
  after: {
    offerId: auditField.id(),
    variantId: auditField.id(),
    recordId: auditField.id(),
    cause: auditField.enumOf(SUPERSEDE_CAUSES),
    supersededByRecordId: auditField.optional(auditField.id()),
  },
});

/**
 * A seller's price write answered `pricing.offer-not-found` (design 5.2, 8; H3, Hassan finding
 * 2). Target: the Offer id the caller sent. At most one row per (actor, Offer) per minute and 20
 * per actor per minute (M7), counted in the same unit. Design 8 names the action
 * `pricing.offer-write-refused`; an audit action has three segments (PA 3.2), so it is
 * `pricing.offer-write.refused`.
 */
export const OfferWriteRefused = defineAuditAction({
  action: 'pricing.offer-write.refused',
  targetType: 'pricing.offer',
  actors: ['authenticated'],
  after: {
    variantId: auditField.id(),
    cause: auditField.enumOf(OFFER_WRITE_REFUSAL_CAUSES),
  },
});

/**
 * The actor reached the per-actor cap of refusal rows in its window (M7): written once, at the
 * first suppressed refusal. It says only that suppression started for the window starting at
 * `windowStartedAt`: no count and no Offer ids (design 19 condition (g); pricing-data 3.8,
 * 12.1). Target: the actor's account. Design 8 names it `pricing.offer-write-refused.suppressed`;
 * an audit action has three segments (PA 3.2), so it is `pricing.offer-write.refusals-suppressed`
 * (Mohammad, part 3b review C2).
 */
export const OfferWriteRefusalsSuppressed = defineAuditAction({
  action: 'pricing.offer-write.refusals-suppressed',
  targetType: 'pricing.write-refusal-actor',
  actors: ['authenticated'],
  after: {
    windowStartedAt: auditField.instant(),
  },
});

/** Every audited action of pricing, for its module's registration. */
export const PRICING_AUDIT_ACTIONS: readonly AuditActionDefinition[] = Object.freeze([
  RegularPriceAccepted,
  RegularPriceHeld,
  RegularPriceSuperseded,
  OfferWriteRefused,
  OfferWriteRefusalsSuppressed,
]);
