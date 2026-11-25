import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import type { AuditActionDefinition } from '@mondapac/shared-kernel';
import { HOLD_REJECTION_REASONS } from '../price-series';
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
// Slice 1, part 3b: the seller's regular-price write and its refusals. Slice 4 adds the hold
// decisions (an approval and a rejection by an admin) and the retirement rows (system actor); the
// re-key rows and Cost come with their slices. A rejection row carries the reason code only: the
// optional note is personal free text and stays on the record (design 8).

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
 * (`replaced`, naming the successor), a write equal to the price in force (`cancelled`), or, by
 * the system actor, the retirement of its series (`offer-removed`, `variant-removed`).
 */
export const RegularPriceSuperseded = defineAuditAction({
  action: 'pricing.regular-price.superseded',
  targetType: PRICE_SERIES_TARGET,
  actors: ['authenticated', 'system'],
  after: {
    offerId: auditField.id(),
    variantId: auditField.id(),
    recordId: auditField.id(),
    cause: auditField.enumOf(SUPERSEDE_CAUSES),
    supersededByRecordId: auditField.optional(auditField.id()),
  },
});

/**
 * An admin approved a held regular price (design 3.1 row 3, 8). The decider is the audit row's
 * actor; the amount uses the kernel's `money` kind. Target: the series.
 */
export const PriceHoldApproved = defineAuditAction({
  action: 'pricing.price-hold.approved',
  targetType: PRICE_SERIES_TARGET,
  actors: ['authenticated'],
  after: {
    offerId: auditField.id(),
    variantId: auditField.id(),
    recordId: auditField.id(),
    amount: auditField.money(),
    /** Null for a first price held against the Variant's reference (R4): see `referenceAmount`. */
    anchorRecordId: auditField.optional(auditField.id()),
    anchorAmount: auditField.optional(auditField.money()),
    /** R4: the reference a held first price was measured against; null for a jump hold. */
    referenceAmount: auditField.optional(auditField.money()),
    effectiveFrom: auditField.instant(),
  },
});

/**
 * An admin rejected a held regular price (design 3.1 row 4, 8). The reason code is in the row;
 * the optional note is not (personal free text, kept on the record). Target: the series.
 */
export const PriceHoldRejected = defineAuditAction({
  action: 'pricing.price-hold.rejected',
  targetType: PRICE_SERIES_TARGET,
  actors: ['authenticated'],
  after: {
    offerId: auditField.id(),
    variantId: auditField.id(),
    recordId: auditField.id(),
    amount: auditField.money(),
    reasonCode: auditField.enumOf(HOLD_REJECTION_REASONS),
  },
});

/** Why a running or scheduled special stopped early (design 3.2, 6.4). */
export const SPECIAL_WITHDRAW_CAUSES = [
  'withdrawn',
  'replaced',
  'offer-removed',
  'variant-removed',
] as const;

/**
 * A seller's special price was accepted without review (design 3.2 row 1). The window is two UTC
 * instants; `effectiveFrom` is its start. Cost never appears here (ADR-0024).
 */
export const SpecialPriceAccepted = defineAuditAction({
  action: 'pricing.special-price.accepted',
  targetType: PRICE_SERIES_TARGET,
  actors: ['authenticated'],
  after: {
    offerId: auditField.id(),
    variantId: auditField.id(),
    recordId: auditField.id(),
    amount: auditField.money(),
    startsAt: auditField.instant(),
    endsAt: auditField.instant(),
    effectiveFrom: auditField.instant(),
  },
});

/** A seller's special price was held for review (design 3.2 row 2, Q8). */
export const SpecialPriceHeld = defineAuditAction({
  action: 'pricing.special-price.held',
  targetType: PRICE_SERIES_TARGET,
  actors: ['authenticated'],
  after: {
    offerId: auditField.id(),
    variantId: auditField.id(),
    recordId: auditField.id(),
    amount: auditField.money(),
    startsAt: auditField.instant(),
    endsAt: auditField.instant(),
    /** The larger of the regular price and the regular jump anchor: what the hold was measured against. */
    referenceAmount: auditField.money(),
  },
});

/**
 * A running or scheduled special was ended before its end (design 3.2): by the seller, by a
 * newer special that replaced it, or by the retirement of its series (system actor).
 */
export const SpecialPriceWithdrawn = defineAuditAction({
  action: 'pricing.special-price.withdrawn',
  targetType: PRICE_SERIES_TARGET,
  actors: ['authenticated', 'system'],
  after: {
    offerId: auditField.id(),
    variantId: auditField.id(),
    recordId: auditField.id(),
    cause: auditField.enumOf(SPECIAL_WITHDRAW_CAUSES),
  },
});

/**
 * A pending special was superseded (design 3.2): replaced by a newer special, cancelled by the
 * seller, or retired with its series (system actor).
 */
export const SpecialPriceSuperseded = defineAuditAction({
  action: 'pricing.special-price.superseded',
  targetType: PRICE_SERIES_TARGET,
  actors: ['authenticated', 'system'],
  after: {
    offerId: auditField.id(),
    variantId: auditField.id(),
    recordId: auditField.id(),
    cause: auditField.enumOf(SUPERSEDE_CAUSES),
    supersededByRecordId: auditField.optional(auditField.id()),
  },
});

/** Why a series was retired (design 6.4). */
export const SERIES_RETIRE_CAUSES = ['offer-removed', 'variant-removed'] as const;

/**
 * A retirement handler retired a price series (design 6.4; system actor). No amount: the rows of
 * the pending records it superseded are `pricing.regular-price.superseded`.
 */
export const PriceSeriesRetired = defineAuditAction({
  action: 'pricing.series.retired',
  targetType: PRICE_SERIES_TARGET,
  actors: ['system'],
  after: {
    offerId: auditField.id(),
    variantId: auditField.id(),
    cause: auditField.enumOf(SERIES_RETIRE_CAUSES),
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

/**
 * What the R4 check of a first price found (risk-based Offer approval, ADR-0051): `no-reference`
 * (fewer distinct businesses than the Market needs), `reference-unavailable` (catalog, sellers or
 * settings could not answer), `within` the band, or `outside` it (the price is held).
 */
export const FIRST_PRICE_CHECK_OUTCOMES = [
  'no-reference',
  'reference-unavailable',
  'within',
  'outside',
] as const;

/**
 * A seller's first regular price on a Variant was checked against the Variant's reference (R4).
 * One row per first price, whatever the outcome, in the unit of the write; an `outside` row is the
 * audit of the hold (the record is pending, anchor-less). Target: the series.
 */
export const FirstPriceChecked = defineAuditAction({
  action: 'pricing.first-price.checked',
  targetType: PRICE_SERIES_TARGET,
  actors: ['authenticated'],
  after: {
    offerId: auditField.id(),
    variantId: auditField.id(),
    recordId: auditField.id(),
    amount: auditField.money(),
    outcome: auditField.enumOf(FIRST_PRICE_CHECK_OUTCOMES),
    referenceAmount: auditField.optional(auditField.money()),
    businesses: auditField.integer(),
    businessesNeeded: auditField.integer(),
    bandPercent: auditField.integer(),
    direction: auditField.optional(auditField.enumOf(HOLD_DIRECTIONS)),
    /** True when the Offer goes to the post-publication review list (no reference). */
    postReview: auditField.boolean(),
  },
});

/**
 * An earlier first price that had no reference was measured once the Variant's reference formed
 * (R4 re-check). `outside` sends it to the post-publication review list; nothing is held, because
 * the price already sells. Target: that earlier price's series. The actor is the seller whose write
 * formed the reference.
 */
export const FirstPriceRechecked = defineAuditAction({
  action: 'pricing.first-price.rechecked',
  targetType: PRICE_SERIES_TARGET,
  actors: ['authenticated'],
  after: {
    offerId: auditField.id(),
    variantId: auditField.id(),
    amount: auditField.money(),
    outcome: auditField.enumOf(['within', 'outside'] as const),
    referenceAmount: auditField.money(),
    businesses: auditField.integer(),
    bandPercent: auditField.integer(),
  },
});

/** Every audited action of pricing, for its module's registration. */
export const PRICING_AUDIT_ACTIONS: readonly AuditActionDefinition[] = Object.freeze([
  RegularPriceAccepted,
  RegularPriceHeld,
  RegularPriceSuperseded,
  PriceHoldApproved,
  PriceHoldRejected,
  SpecialPriceAccepted,
  SpecialPriceHeld,
  SpecialPriceWithdrawn,
  SpecialPriceSuperseded,
  PriceSeriesRetired,
  OfferWriteRefused,
  OfferWriteRefusalsSuppressed,
  FirstPriceChecked,
  FirstPriceRechecked,
]);
