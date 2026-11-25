import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { ReviewsFacade } from '../../reviews';
import type { ReviewWindowCounts } from '../domain/reviews';
import type { ReviewSources, ReviewSourcesUnavailable } from '../application/ports/review-sources';

/** {@link ReviewSources} on the reviews facade, with the caller's context unchanged. */
export class FacadeReviewSources implements ReviewSources {
  constructor(private readonly reviews: Pick<ReviewsFacade, 'marketReviewCounts'>) {}

  async countsOf(
    context: CallContext,
    windows: readonly { readonly from: Temporal.Instant; readonly to: Temporal.Instant }[],
  ): Promise<Result<readonly ReviewWindowCounts[], ReviewSourcesUnavailable>> {
    const counts = await this.reviews.marketReviewCounts(context, windows);
    if (!counts.ok) return err({ code: counts.error.code });
    return ok(
      counts.value.map(({ reviews, starsSum, histogram }) => ({ reviews, starsSum, histogram })),
    );
  }
}
