import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ratingRow } from '../../domain/rating-boost';
import type { ProductRatingTotal, StoredProductRating } from '../ports/product-rating';
import type { RatingSyncDependencies } from '../rating-sync-dependencies';

/** Totals asked of reviews per call. */
export const RATING_PAGE = 500;
/** Rows written per unit: short transactions, so the sync never holds the search up. */
export const RATING_WRITE_BATCH = 100;

export interface RatingSyncCounts {
  readonly products: number;
  readonly deleted: number;
}

/**
 * `search.sync-product-ratings`: copies the star totals of reviews into `search.product_ratings`
 * for the context's Market, with the Bayesian average and relevance factor the Market's rating
 * boost makes of them (rule `system`; run at worker start and hourly by `search.sync-ratings`).
 *
 * - Boost off in the Market (the default), or reviews off: the copy is emptied, so switching
 *   either off removes the effect at the next run, and search ranks by relevance alone.
 * - Otherwise every page of totals is read first (facade calls, outside any unit), then written in
 *   short units, then the rows this run did not write are deleted. If reviews cannot answer, the
 *   copy is left as it is and the run throws, so the scheduler logs the failure.
 * Safe to run twice and concurrently: each run writes the same numbers and deletes only what it
 * did not write.
 */
export class SyncProductRatings extends UseCase<Record<string, never>, RatingSyncCounts, never> {
  static override readonly access: AccessDeclaration = {
    name: 'search.sync-product-ratings',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: RatingSyncDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<RatingSyncCounts, never>> {
    const { market } = context;
    const { ratingBoost } = this.deps.policy.settings(market);
    const clearAll = async (): Promise<Result<RatingSyncCounts, never>> => {
      const deleted = await this.deps.unitOfWork.run(market, async () =>
        ok(await this.deps.ratings.deleteAll(market)),
      );
      return ok({ products: 0, deleted: deleted.ok ? deleted.value : 0 });
    };
    if (ratingBoost === null) return clearAll();

    const totals: ProductRatingTotal[] = [];
    let after: Id<'Product'> | null = null;
    for (;;) {
      const page = await this.deps.source.page(context, { after, limit: RATING_PAGE });
      if (page === 'disabled') return clearAll();
      if (page === null) throw new Error('search: review ratings unavailable');
      totals.push(...page.items);
      if (page.next === null) break;
      after = page.next;
    }

    const startedAt = this.deps.clock.now();
    const rows: StoredProductRating[] = totals
      .filter((total) => total.count >= 1)
      .map((total) => ({ ...total, ...ratingRow(total.count, total.sum, ratingBoost) }));
    for (let from = 0; from < rows.length; from += RATING_WRITE_BATCH) {
      const batch = rows.slice(from, from + RATING_WRITE_BATCH);
      await this.deps.unitOfWork.run(market, async () => {
        await this.deps.ratings.upsertMany(market, batch, startedAt);
        return ok(undefined);
      });
    }
    const deleted = await this.deps.unitOfWork.run(market, async () =>
      ok(await this.deps.ratings.deleteSyncedBefore(market, startedAt)),
    );
    return ok({ products: rows.length, deleted: deleted.ok ? deleted.value : 0 });
  }
}
