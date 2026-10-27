// The summary math (owner decisions N3, N8). A summary is a count of published ratings, rebuilt
// from the source tables; it is never the source of truth. Averages are integers (hundredths of
// a star) so no float reaches a response or a comparison.

export interface StarSummary {
  readonly count: number;
  readonly sum: number;
  /** Ratings of 1, 2, 3, 4 and 5 stars. */
  readonly histogram: readonly [number, number, number, number, number];
}

export interface SellerSummary extends StarSummary {
  /** Rated seller orders: equals `count`. */
  readonly ratedSellerOrders: number;
  /** Satisfaction 4 or 5. */
  readonly satisfiedCount: number;
  readonly asDescribedYes: number;
  readonly arrivedOkYes: number;
}

const isStar = (value: number): boolean => Number.isInteger(value) && value >= 1 && value <= 5;
const isCount = (value: number): boolean => Number.isInteger(value) && value > 0;

/** Product ratings, grouped by star value (a group with a bad star or a zero count is skipped). */
export function summariseStarGroups(
  groups: readonly { readonly rating: number; readonly count: number }[],
): StarSummary {
  const histogram: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  let count = 0;
  let sum = 0;
  for (const group of groups) {
    if (!isStar(group.rating) || !isCount(group.count)) continue;
    histogram[group.rating - 1]! += group.count;
    count += group.count;
    sum += group.rating * group.count;
  }
  return { count, sum, histogram };
}

/** Seller ratings, grouped by the three answers. */
export function summariseSellerGroups(
  groups: readonly {
    readonly satisfaction: number;
    readonly asDescribed: boolean;
    readonly arrivedOk: boolean;
    readonly count: number;
  }[],
): SellerSummary {
  const stars = summariseStarGroups(
    groups.map((group) => ({ rating: group.satisfaction, count: group.count })),
  );
  let asDescribedYes = 0;
  let arrivedOkYes = 0;
  for (const group of groups) {
    if (!isStar(group.satisfaction) || !isCount(group.count)) continue;
    if (group.asDescribed) asDescribedYes += group.count;
    if (group.arrivedOk) arrivedOkYes += group.count;
  }
  return {
    ...stars,
    ratedSellerOrders: stars.count,
    satisfiedCount: stars.histogram[3] + stars.histogram[4],
    asDescribedYes,
    arrivedOkYes,
  };
}

/** The average in hundredths of a star (4.33 is 433), rounded half up; null for no ratings. */
export function averageTimes100(summary: Pick<StarSummary, 'count' | 'sum'>): number | null {
  if (summary.count <= 0) return null;
  return Math.floor((summary.sum * 100 * 2 + summary.count) / (summary.count * 2));
}

/** A share in basis points (10000 = all), rounded half up; null for no ratings. */
export function shareBps(part: number, count: number): number | null {
  if (count <= 0) return null;
  return Math.floor((part * 10_000 * 2 + count) / (count * 2));
}

/**
 * Whether a summary is meant to be shown: a product from its first review (minimum 1), a seller
 * from the Market's minimum of rated seller orders (N8). The answer carries the count; the web
 * decides.
 */
export function summaryShownFrom(count: number, minimumCount: number): boolean {
  return count >= minimumCount && count > 0;
}
