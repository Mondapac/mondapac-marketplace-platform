import { delta, type Delta } from './period';
import { MIN_COUNT_BASE } from './admin-kpi';

// The reviews card of the admin dashboard (dashboards v2, phase 2): the reviews the Market
// published in the last 30 Market days against the 30 days before, read live from the reviews
// module as counts. Nothing about a review, its author, its product or its seller is kept or shown.

/** Fewer reviews than this in the period: no numbers at all (a handful could be one person's). */
export const MIN_REVIEWS_BASE = MIN_COUNT_BASE;

/** What the reviews module counted for one window. */
export interface ReviewWindowCounts {
  readonly reviews: number;
  readonly starsSum: number;
  /** Reviews of 1, 2, 3, 4 and 5 stars. */
  readonly histogram: readonly [number, number, number, number, number];
}

export type MarketReviews =
  /** Reviews are switched off in this Market (the default until an admin switches them on). */
  | { readonly status: 'off' }
  | {
      readonly status: 'not-enough-data';
      readonly minimum: number;
    }
  | {
      readonly status: 'available';
      /** Reviews published in the period. */
      readonly reviews: number;
      readonly reviewsChange: Delta;
      /** Hundredths of a star (433 is 4.33). */
      readonly averageTimes100: number;
      /** Change of the average in hundredths of a star; `na` below {@link MIN_REVIEWS_BASE} reviews before. */
      readonly averageChangeTimes100: Delta;
      /** Reviews of 1, 2, 3, 4 and 5 stars in the period. */
      readonly histogram: readonly [number, number, number, number, number];
      /** Reviews of 1 or 2 stars ÷ reviews, in basis points of a hundredth: 10000 is all. */
      readonly lowStarShareBp: number;
      /** The share against the period before, in basis points of difference; `na` as above. */
      readonly lowStarShareChange: Delta;
    };

const NA: Delta = { value: 0, direction: 'flat', state: 'na' };

const lowShareBp = (counts: ReviewWindowCounts): number =>
  counts.reviews === 0
    ? 0
    : Math.round(((counts.histogram[0] + counts.histogram[1]) * 10_000) / counts.reviews);

const averageTimes100 = (counts: ReviewWindowCounts): number =>
  counts.reviews === 0 ? 0 : Math.round((counts.starsSum * 100) / counts.reviews);

function checked(counts: ReviewWindowCounts): ReviewWindowCounts {
  const sum = counts.histogram.reduce((a, n) => a + n, 0);
  const stars = counts.histogram.reduce((a, n, i) => a + n * (i + 1), 0);
  if (
    !counts.histogram.every((n) => Number.isSafeInteger(n) && n >= 0) ||
    sum !== counts.reviews ||
    stars !== counts.starsSum
  ) {
    throw new RangeError('reporting: review counts that do not add up');
  }
  return counts;
}

/**
 * The reviews of `current` against `previous`. Below {@link MIN_REVIEWS_BASE} reviews in the
 * period it is `not-enough-data` (nothing else is given); changes against the period before
 * are `na` while that period had fewer than that many.
 */
export function marketReviewsOf(
  current: ReviewWindowCounts,
  previous: ReviewWindowCounts,
): MarketReviews {
  const now = checked(current);
  const before = checked(previous);
  if (now.reviews < MIN_REVIEWS_BASE) {
    return { status: 'not-enough-data', minimum: MIN_REVIEWS_BASE };
  }
  const baseIsEnough = before.reviews >= MIN_REVIEWS_BASE;
  const averageNow = averageTimes100(now);
  const lowNow = lowShareBp(now);
  const change = (a: number, b: number): Delta => {
    if (!baseIsEnough) return NA;
    const diff = a - b;
    return { value: diff, direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat', state: 'ok' };
  };
  return {
    status: 'available',
    reviews: now.reviews,
    reviewsChange: baseIsEnough ? delta(now.reviews, before.reviews, MIN_REVIEWS_BASE) : NA,
    averageTimes100: averageNow,
    averageChangeTimes100: change(averageNow, averageTimes100(before)),
    histogram: now.histogram,
    lowStarShareBp: lowNow,
    lowStarShareChange: change(lowNow, lowShareBp(before)),
  };
}
