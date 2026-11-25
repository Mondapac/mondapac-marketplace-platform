import type { CallContext, Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** The priced unit whose reference is read: the product copy keys the series index. */
export interface VariantKey {
  readonly productId: Id<'Product'>;
  readonly variantId: Id<'Variant'>;
}

/** The regular price in force of one series of the Variant (R4, ADR-0051). Never a special. */
export interface VariantRegularPrice {
  readonly seriesId: Id<'PriceSeries'>;
  readonly offerId: Id<'Offer'>;
  readonly sellerId: Id<'Seller'>;
  /** Minor units of the Market currency. */
  readonly amountMinor: bigint;
}

/**
 * At most this many prices are read per Variant: catalog answers 200 Offers per call and sellers
 * 100 per call, so the reader stays within two of each. A Variant with more Offers is measured
 * against the first 200 by series id (the oldest series), which is still a fair sample.
 */
export const MAX_REFERENCE_PRICES = 200;

/**
 * pricing's own prices of one Variant (R4): the regular record in force at `now` of every series of
 * (product, Variant) that is not retired, oldest series first, at most {@link MAX_REFERENCE_PRICES}.
 * Runs in the open unit; liveness and businesses are decided by the caller through the facades.
 */
export interface VariantPriceReader {
  regularPricesInForce(
    market: MarketContext,
    key: VariantKey,
    now: Temporal.Instant,
  ): Promise<readonly VariantRegularPrice[]>;
}
export const VARIANT_PRICE_READER = Symbol('PRICING_VARIANT_PRICE_READER');

/**
 * Which sellers count as a business for the reference (R4): those `sellers` says may sell now. One
 * approved seller is one business identifier (ABN) in the Market, and a seller whose identifier
 * claim is in conflict is not eligible (sellers design 3.6). Throws when `sellers` refuses: the
 * caller reads that as "reference unavailable". A failure inside `sellers` may instead come back as
 * "not eligible" (the facade fails closed for a request actor), which counts fewer businesses; it
 * never widens the band.
 */
export interface ReferenceBusinesses {
  eligibleSellers(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlySet<Id<'Seller'>>>;
}
export const REFERENCE_BUSINESSES = Symbol('PRICING_REFERENCE_BUSINESSES');

/** The two Market settings of R4 (ADR-0051), admin-editable on Settings → Catalogue. */
export interface ReferenceSettings {
  /** Distinct businesses needed before a Variant has a reference price. */
  readonly referenceSellers: number;
  /** A first price more than this percent above or below the reference is held. */
  readonly priceBandPercent: number;
}

/** The settings through `SettingsFacade.offerReviewPolicy`; its own failure answer is the safe one. */
export interface ReferenceSettingsSource {
  settings(context: CallContext): Promise<ReferenceSettings>;
}
export const REFERENCE_SETTINGS = Symbol('PRICING_REFERENCE_SETTINGS');

/** What the R4 check of a first price found; mirrors the audit action's outcome. */
export type FirstPriceCheckOutcome =
  'no-reference' | 'reference-unavailable' | 'within' | 'outside';

/** Why an Offer is on the post-publication review list because of its price (R4). */
export type PricePostReviewReason = 'no-reference' | 'reference-unavailable' | 'recheck-outside';

/** One stored R4 check: one row per checked first-price record (`pricing.first_price_checks`). */
export interface FirstPriceCheck {
  readonly recordId: Id<'RegularPriceRecord'>;
  readonly seriesId: Id<'PriceSeries'>;
  readonly offerId: Id<'Offer'>;
  readonly productId: Id<'Product'>;
  readonly variantId: Id<'Variant'>;
  readonly sellerId: Id<'Seller'>;
  readonly outcome: FirstPriceCheckOutcome;
  /** The median rounded half up; null without a reference. */
  readonly referenceAmountMinor: bigint | null;
  readonly businesses: number;
  readonly businessesNeeded: number;
  readonly bandPercent: number;
  /** Set for `no-reference` and `reference-unavailable`: 100% post-publication review. */
  readonly postReviewReason: PricePostReviewReason | null;
  readonly checkedAt: Temporal.Instant;
}

/** A stored check still waiting for the Variant's first reference (R4 re-check). */
export interface PendingRecheck {
  readonly recordId: Id<'RegularPriceRecord'>;
  readonly seriesId: Id<'PriceSeries'>;
  readonly offerId: Id<'Offer'>;
  readonly sellerId: Id<'Seller'>;
  readonly variantId: Id<'Variant'>;
}

/** The re-check of one earlier check, once the Variant's reference formed. */
export interface Recheck {
  readonly recordId: Id<'RegularPriceRecord'>;
  readonly outcome: 'within' | 'outside';
  readonly referenceAmountMinor: bigint;
  /** The Offer's regular price in force that was measured. */
  readonly amountMinor: bigint;
  readonly at: Temporal.Instant;
}

/** At most this many earlier checks are re-checked by one write (the oldest first). */
export const MAX_RECHECKS_PER_WRITE = 100;

/**
 * The store of R4 checks (pricing-data, `pricing.first_price_checks`). Insert once; a check is
 * re-checked at most once (a conditional update on `rechecked_at IS NULL`).
 */
export interface FirstPriceCheckStore {
  record(market: MarketContext, check: FirstPriceCheck): Promise<void>;
  /** Checks of the Variant with no reference and no re-check yet, oldest first, at most 100. */
  pendingRechecks(market: MarketContext, key: VariantKey): Promise<readonly PendingRecheck[]>;
  /** False when another write re-checked it first: the caller writes no audit row then. */
  markRechecked(market: MarketContext, recheck: Recheck): Promise<boolean>;
}
export const FIRST_PRICE_CHECK_STORE = Symbol('PRICING_FIRST_PRICE_CHECK_STORE');
