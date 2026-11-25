import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { CostSeries } from '../../domain/cost/cost-series';

/**
 * What `add` did. `key-retired`: a retirement tombstone exists for the Offer or for the
 * (product, Variant), so no series was created (design 5.2, 6.4); the use case answers
 * `pricing.offer-not-found`, as for a price.
 */
export type AddCostSeriesOutcome = 'added' | 'key-retired';

/**
 * The store of Cost series and their records (pricing-data 3.7). Only the Cost use cases
 * (`application/use-cases/*cost*`) import this port and only `infrastructure/cost/` implements it
 * (`pnpm boundaries`, H-D1). Every method runs in the open unit of the use case, through the
 * Market-scoped client. Records are append-only: a save raises the version and inserts the new
 * record, nothing else.
 */
export interface CostSeriesRepository {
  /** The series of one key in this Market with its latest record, or null. */
  findByKey(
    market: MarketContext,
    key: { readonly offerId: Id<'Offer'>; readonly variantId: Id<'Variant'> },
  ): Promise<CostSeries | null>;

  /** Every series of one Offer in this Market, each with its latest record. */
  findByOffer(market: MarketContext, offerId: Id<'Offer'>): Promise<readonly CostSeries[]>;

  /**
   * Inserts a new series and its first record. Runs only in a serializable unit opened by
   * `runSerializable` (pricing-data 5.1): it reads the two tombstones first and answers
   * `key-retired` without writing when either exists.
   */
  add(market: MarketContext, series: CostSeries): Promise<AddCostSeriesOutcome>;

  /** Raises the version under the stored one (stale otherwise) and inserts the appended record. */
  save(market: MarketContext, series: CostSeries): Promise<void>;
}

export const COST_SERIES_REPOSITORY = Symbol('COST_SERIES_REPOSITORY');
