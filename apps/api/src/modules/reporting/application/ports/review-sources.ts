import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { ReviewWindowCounts } from '../../domain/reviews';

/** Why the review counts could not be read: the owner's code (`reviews.disabled` is its own state). */
export interface ReviewSourcesUnavailable {
  readonly code: string;
}

/**
 * What the dashboard reads of the reviews module (dashboards v2, phase 2): counts per window, as
 * the caller. Nothing about a review itself comes back to reporting.
 */
export interface ReviewSources {
  countsOf(
    context: CallContext,
    windows: readonly { readonly from: Temporal.Instant; readonly to: Temporal.Instant }[],
  ): Promise<Result<readonly ReviewWindowCounts[], ReviewSourcesUnavailable>>;
}

export const REVIEW_SOURCES = Symbol('reporting.ReviewSources');
