import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PriceSeries } from '../../domain/price-series';

/** The priced unit (pricing design 2.1; ADR-0024 decision 1). */
export interface PriceSeriesKey {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
}

/**
 * What `add` did. `key-retired`: a retirement tombstone exists for the Offer or for the
 * (product, Variant), so no series was created (pricing design 5.2, 6.4; Hassan finding 3); the
 * use case answers `pricing.offer-not-found`.
 */
export type AddPriceSeriesOutcome = 'added' | 'key-retired';

/**
 * The store of price series and their regular records (pricing-data 3.2, 3.3). Every method runs
 * in the open unit of the use case, through the Market-scoped client. Records are never deleted
 * and their content never changes; a save writes only the status, period-end and supersede
 * columns of existing records, and inserts the new ones.
 */
export interface PriceSeriesRepository {
  /**
   * The series of one key in this Market with every regular record, oldest submission first, or
   * null. Another Market's key is not found.
   */
  findByKey(market: MarketContext, key: PriceSeriesKey): Promise<PriceSeries | null>;

  /** Every series of an Offer, retired ones included (the Offer-removed handler, D 6.4). */
  findByOffer(market: MarketContext, offerId: Id<'Offer'>): Promise<readonly PriceSeries[]>;

  /** Every series of a (product, Variant), retired ones included (the Variant-removed handler). */
  findByProductVariant(
    market: MarketContext,
    productId: Id<'Product'>,
    variantId: Id<'Variant'>,
  ): Promise<readonly PriceSeries[]>;

  /**
   * Creates a series built by `PriceSeries.create`, with whatever records it already holds (its
   * first price). Reads both retirement tombstones first and writes nothing when either exists.
   * The row is inserted at version 1 (P 10), then raised to the aggregate's version with its
   * records, in the statement order of pricing-data P7.
   *
   * The caller's unit must be `serializable` (pricing-data 5.1): only then can a concurrent
   * retirement handler not leave a live series after its tombstone. Fails closed (Hassan M1):
   * outside a unit opened by `runSerializable` it throws `SerializableUnitRequiredError` before
   * any statement. Throws `StaleAggregateError`
   * when the key already has a series in the Market (the unique key decides a creation race,
   * P 10), and the unit retries a `40001`.
   */
  add(market: MarketContext, series: PriceSeries): Promise<AddPriceSeriesOutcome>;

  /**
   * Writes the changes of a stored series under the version it was read at (P 10), statement
   * order P7: the version first, then the records it shrinks (superseded, closed), then the new
   * records. Throws `StaleAggregateError` when the series changed since it was read.
   */
  save(market: MarketContext, series: PriceSeries): Promise<void>;
}

export const PRICE_SERIES_REPOSITORY = Symbol('PRICE_SERIES_REPOSITORY');
