import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** An Offer retired by `catalog.offer-deleted.v1` (pricing-data 3.6). */
export interface RetiredOfferTombstone {
  readonly offerId: Id<'Offer'>;
  readonly retiredAt: Temporal.Instant;
  /** catalog's event id, for tracing. */
  readonly causeEventId: string;
}

/**
 * A (product, Variant) retired by `catalog.variant-removed.v1`, or moved away by the CF4 re-key
 * (pricing-data 3.6, 3.2.1). Keyed by product: the event carries no Offer id (M5).
 */
export interface RetiredVariantTombstone {
  readonly productId: Id<'Product'>;
  readonly variantId: Id<'Variant'>;
  readonly retiredAt: Temporal.Instant;
  readonly causeEventId: string;
}

/**
 * The retirement tombstones (pricing design 6.4, PD7; pricing-data 3.6): insert-only, never
 * removed. A handler records one even when no series exists, so a price written after the event
 * never creates a live series (Hassan finding 3). The read side lives in
 * `PriceSeriesRepository.add`, in the unit that creates a series.
 */
export interface RetirementTombstoneRepository {
  /** True when this call inserted the tombstone, false when it was already there (redelivery). */
  recordRetiredOffer(market: MarketContext, tombstone: RetiredOfferTombstone): Promise<boolean>;

  /** As `recordRetiredOffer`, for a (product, Variant). */
  recordRetiredVariant(market: MarketContext, tombstone: RetiredVariantTombstone): Promise<boolean>;
}

export const RETIREMENT_TOMBSTONE_REPOSITORY = Symbol('RETIREMENT_TOMBSTONE_REPOSITORY');
