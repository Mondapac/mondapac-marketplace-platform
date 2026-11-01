import type { CallContext, Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** The star totals of one product, as reviews' public facade gives them. */
export interface ProductRatingTotal {
  readonly productId: Id<'Product'>;
  readonly count: number;
  readonly sum: number;
}

/** One page of totals, ordered by product id; `next` is the `after` of the following page. */
export interface ProductRatingPage {
  readonly items: readonly ProductRatingTotal[];
  readonly next: Id<'Product'> | null;
}

/**
 * Where search gets the star totals (reviews' facade). `disabled` means reviews are off in the
 * Market (so the copy is emptied); `null` means the source could not answer (the copy is left as
 * it is and the job fails, so the scheduler logs it).
 */
export interface ProductRatingSource {
  page(
    context: CallContext,
    request: { readonly after: Id<'Product'> | null; readonly limit: number },
  ): Promise<ProductRatingPage | 'disabled' | null>;
}

export const PRODUCT_RATING_SOURCE = Symbol('PRODUCT_RATING_SOURCE');

/** One stored row of `search.product_ratings`: the totals and what the boost made of them. */
export interface StoredProductRating extends ProductRatingTotal {
  readonly bayesTimes1000: number;
  readonly boostPpm: number;
}

/** The search copy of the star totals (`search.product_ratings`), written only by the sync. */
export interface ProductRatingRepository {
  upsertMany(
    market: MarketContext,
    rows: readonly StoredProductRating[],
    syncedAt: Temporal.Instant,
  ): Promise<void>;
  /** Deletes the rows this sync did not write (synced before `before`); returns how many. */
  deleteSyncedBefore(market: MarketContext, before: Temporal.Instant): Promise<number>;
  /** Empties the copy of the Market; returns how many rows went. */
  deleteAll(market: MarketContext): Promise<number>;
}

export const PRODUCT_RATING_REPOSITORY = Symbol('PRODUCT_RATING_REPOSITORY');
