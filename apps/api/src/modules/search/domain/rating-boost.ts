// The staged rating boost of the text search (buyer reviews and ratings package 5, owner decision
// N9), as pure integer arithmetic. The sync job calls these to compute what it stores per
// product; search's SQL only multiplies and orders by the stored numbers (ADR-0030 allows no
// arithmetic beyond one multiplication). Nothing here reads a clock or a Market.

/** The Market's boost settings (`search.ratingBoost` in Market config), while the boost is on. */
export interface RatingBoostSettings {
  /** The most the boost may move a result's relevance, in basis points (0 to 1000). */
  readonly weightBps: number;
  /** Imaginary ratings every product starts with. */
  readonly priorCount: number;
  /** Their mean, in hundredths of a star (400 is 4.00). */
  readonly priorMeanTimes100: number;
}

/** No change to the relevance, in millionths. */
export const NEUTRAL_BOOST_PPM = 1_000_000;
/** The cap of the boost whatever the config says: 10 % either way (the table CHECK says the same). */
export const MAX_WEIGHT_BPS = 1000;
/** How far from the prior mean (in thousandths of a star) the boost reaches its full weight. */
const FULL_EFFECT_DISTANCE_TIMES_1000 = 2000;

/** The prior mean in thousandths of a star: what a product with no ratings is worth. */
export const priorMeanTimes1000 = (boost: RatingBoostSettings): number =>
  boost.priorMeanTimes100 * 10;

/**
 * The Bayesian average of a product's stars, times 1000, rounded to the nearest whole number:
 * `(priorCount * priorMean + sum) / (priorCount + count)`. A product with one five-star review is
 * pulled towards the prior mean, so it does not beat a product with two hundred reviews at 4.7;
 * a product with no ratings is exactly at the prior mean.
 */
export function bayesTimes1000(
  count: number,
  sum: number,
  boost: Pick<RatingBoostSettings, 'priorCount' | 'priorMeanTimes100'>,
): number {
  const numerator = boost.priorCount * boost.priorMeanTimes100 * 10 + sum * 1000;
  return Math.round(numerator / (boost.priorCount + count));
}

/**
 * The relevance factor in millionths: `1 + weight * d`, where `d` is how far the Bayesian average
 * is from the prior mean in steps of two stars, clamped to [-1, 1]. At the prior mean the factor
 * is exactly 1; at the weight's 10 % cap it never leaves [0.9, 1.1].
 */
export function boostPpm(bayes: number, boost: RatingBoostSettings): number {
  const weightBps = Math.min(Math.max(boost.weightBps, 0), MAX_WEIGHT_BPS);
  const distance = Math.min(
    Math.max((bayes - priorMeanTimes1000(boost)) / FULL_EFFECT_DISTANCE_TIMES_1000, -1),
    1,
  );
  return Math.round(NEUTRAL_BOOST_PPM + weightBps * 100 * distance);
}

/** What the sync stores for one product with `count` ratings adding up to `sum` stars. */
export function ratingRow(
  count: number,
  sum: number,
  boost: RatingBoostSettings,
): { readonly bayesTimes1000: number; readonly boostPpm: number } {
  const bayes = bayesTimes1000(count, sum, boost);
  return { bayesTimes1000: bayes, boostPpm: boostPpm(bayes, boost) };
}
