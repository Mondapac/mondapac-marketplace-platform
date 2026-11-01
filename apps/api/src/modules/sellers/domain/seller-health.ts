/**
 * Seller health score (HLT-01..05, seller-health plan 31 Oct 2026). Pure domain: no clock, no
 * storage, no Market constant. Every threshold arrives in a {@link SellerHealthSettings} that a
 * Market setting supplies (ADM-06); the numbers live in settings and test fixtures, not here.
 *
 * Rules: each metric scores 0..100, linear inside its band (67..100 healthy, 34..66 at risk,
 * 0..33 unhealthy); the overall score is the LOWEST metric that has data, named with its
 * metric; a seller below `minOrders` orders in the window is `new`. Faults that are not the
 * seller's (customer cancels, failed payments, courier delays, disputes the seller won) are
 * excluded by whoever builds the inputs, never counted here. Nothing here acts on a seller.
 */

/** Stored with every score so a change of thresholds or shape can be traced. */
export const SELLER_HEALTH_FORMULA_VERSION = 'v1';

export const SELLER_HEALTH_METRICS = [
  'seller-cancellations',
  'late-ready',
  'customer-rating',
  'lost-disputes',
  'reports',
] as const;
export type SellerHealthMetric = (typeof SELLER_HEALTH_METRICS)[number];

export type HealthBand = 'healthy' | 'at-risk' | 'unhealthy';

/** Lower is better: healthy below `healthyBelow`, at risk up to and including `atRiskUpTo`. */
export interface LowerIsBetterThresholds {
  readonly healthyBelow: number;
  readonly atRiskUpTo: number;
  /** The value at which the score reaches 0. Above `atRiskUpTo`. */
  readonly zeroAt: number;
}

/** Higher is better (rating in hundredths): healthy at `healthyFrom` or more, at risk from `atRiskFrom`. */
export interface HigherIsBetterThresholds {
  readonly healthyFrom: number;
  readonly atRiskFrom: number;
  /** Best possible value (score 100) and the value that scores 0. */
  readonly best: number;
  readonly zeroAt: number;
}

export interface SellerHealthSettings {
  /** Orders in the window before a seller gets a score; fewer means `new`. */
  readonly minOrders: number;
  /** Reviews before the rating counts; fewer means no data. */
  readonly minReviews: number;
  /** Rates in basis points (1% = 100). */
  readonly sellerCancellations: LowerIsBetterThresholds;
  readonly lateReady: LowerIsBetterThresholds;
  readonly lostDisputes: LowerIsBetterThresholds;
  /** Average rating in hundredths (4.60 = 460). */
  readonly customerRating: HigherIsBetterThresholds;
  /** Confirmed reports, a count. */
  readonly reports: LowerIsBetterThresholds;
}

/** A count over a base, both non-negative safe integers (units, orders). */
export interface RateInput {
  readonly count: number;
  readonly base: number;
}

export interface SellerHealthInput {
  /** Orders in the window; below `minOrders` the seller is `new`. */
  readonly orders: number;
  readonly sellerCancellations: RateInput;
  readonly lateReady: RateInput;
  readonly lostDisputes: RateInput;
  /** Approved reviews in the window; `averageHundredths` is ignored when `count` is 0. */
  readonly customerRating: { readonly count: number; readonly averageHundredths: number };
  /** `null` until a reports source exists (MOD-14): the metric has no data. */
  readonly reports: { readonly count: number } | null;
}

export type MetricResult =
  | {
      readonly metric: SellerHealthMetric;
      readonly kind: 'scored';
      readonly band: HealthBand;
      readonly score: number;
    }
  | { readonly metric: SellerHealthMetric; readonly kind: 'no-data' };

export type SellerHealth =
  | {
      readonly kind: 'new';
      readonly metrics: readonly MetricResult[];
      readonly formulaVersion: string;
    }
  | {
      readonly kind: 'no-data';
      readonly metrics: readonly MetricResult[];
      readonly formulaVersion: string;
    }
  | {
      readonly kind: 'scored';
      readonly band: HealthBand;
      readonly score: number;
      /** The metric that set the overall score (the lowest; first in list order on a tie). */
      readonly lowestMetric: SellerHealthMetric;
      readonly metrics: readonly MetricResult[];
      readonly formulaVersion: string;
    };

const HEALTHY_TOP = 100;
const HEALTHY_BOTTOM = 67;
const AT_RISK_TOP = 66;
const AT_RISK_BOTTOM = 34;
const UNHEALTHY_TOP = 33;

export function bandOfScore(score: number): HealthBand {
  if (score >= HEALTHY_BOTTOM) return 'healthy';
  if (score >= AT_RISK_BOTTOM) return 'at-risk';
  return 'unhealthy';
}

/** Linear interpolation from `from` (at 0) to `to` (at 1), rounded to an integer. */
function lerp(from: number, to: number, fraction: number): number {
  const f = Math.min(1, Math.max(0, fraction));
  return Math.round(from + (to - from) * f);
}

/** Validates thresholds; a Market setting that breaks the order is a configuration error. */
export function assertSellerHealthSettings(s: SellerHealthSettings): void {
  const lower: ReadonlyArray<[string, LowerIsBetterThresholds]> = [
    ['sellerCancellations', s.sellerCancellations],
    ['lateReady', s.lateReady],
    ['lostDisputes', s.lostDisputes],
    ['reports', s.reports],
  ];
  for (const [name, t] of lower) {
    if (!(0 < t.healthyBelow && t.healthyBelow <= t.atRiskUpTo && t.atRiskUpTo < t.zeroAt)) {
      throw new RangeError(`seller-health.settings: ${name} thresholds out of order`);
    }
  }
  const r = s.customerRating;
  if (!(r.zeroAt < r.atRiskFrom && r.atRiskFrom < r.healthyFrom && r.healthyFrom < r.best)) {
    throw new RangeError('seller-health.settings: customerRating thresholds out of order');
  }
  if (!Number.isSafeInteger(s.minOrders) || s.minOrders < 1) {
    throw new RangeError('seller-health.settings: minOrders');
  }
  if (!Number.isSafeInteger(s.minReviews) || s.minReviews < 1) {
    throw new RangeError('seller-health.settings: minReviews');
  }
}

function scoreLower(value: number, t: LowerIsBetterThresholds): number {
  if (value < t.healthyBelow) return lerp(HEALTHY_TOP, HEALTHY_BOTTOM, value / t.healthyBelow);
  if (value <= t.atRiskUpTo) {
    const span = t.atRiskUpTo - t.healthyBelow;
    return span === 0
      ? AT_RISK_BOTTOM
      : lerp(AT_RISK_TOP, AT_RISK_BOTTOM, (value - t.healthyBelow) / span);
  }
  return lerp(UNHEALTHY_TOP, 0, (value - t.atRiskUpTo) / (t.zeroAt - t.atRiskUpTo));
}

function scoreHigher(value: number, t: HigherIsBetterThresholds): number {
  if (value >= t.healthyFrom)
    return lerp(HEALTHY_BOTTOM, HEALTHY_TOP, (value - t.healthyFrom) / (t.best - t.healthyFrom));
  if (value >= t.atRiskFrom) {
    return lerp(
      AT_RISK_BOTTOM,
      AT_RISK_TOP,
      (value - t.atRiskFrom) / (t.healthyFrom - t.atRiskFrom),
    );
  }
  return lerp(0, UNHEALTHY_TOP, (value - t.zeroAt) / (t.atRiskFrom - t.zeroAt));
}

function scored(metric: SellerHealthMetric, score: number): MetricResult {
  return { metric, kind: 'scored', band: bandOfScore(score), score };
}

/** A rate in basis points, integer math (no float drift at a boundary). */
function rateBasisPoints(r: RateInput): number {
  return (r.count * 10000) / r.base;
}

function rateMetric(
  metric: SellerHealthMetric,
  r: RateInput,
  t: LowerIsBetterThresholds,
  minBase: number,
): MetricResult {
  if (r.base < minBase) return { metric, kind: 'no-data' };
  return scored(metric, scoreLower(rateBasisPoints(r), t));
}

function assertCounts(input: SellerHealthInput): void {
  const values = [
    input.orders,
    input.sellerCancellations.count,
    input.sellerCancellations.base,
    input.lateReady.count,
    input.lateReady.base,
    input.lostDisputes.count,
    input.lostDisputes.base,
    input.customerRating.count,
    input.reports?.count ?? 0,
  ];
  for (const v of values) {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError('seller-health.input: not a count');
  }
  for (const r of [input.sellerCancellations, input.lateReady, input.lostDisputes]) {
    if (r.count > r.base) throw new RangeError('seller-health.input: count above base');
  }
}

/** Computes the health of one seller from counts already filtered to the seller's own faults. */
export function computeSellerHealth(
  input: SellerHealthInput,
  settings: SellerHealthSettings,
): SellerHealth {
  assertSellerHealthSettings(settings);
  assertCounts(input);

  const rating = input.customerRating;
  const metrics: readonly MetricResult[] = [
    rateMetric(
      'seller-cancellations',
      input.sellerCancellations,
      settings.sellerCancellations,
      settings.minOrders,
    ),
    rateMetric('late-ready', input.lateReady, settings.lateReady, settings.minOrders),
    rating.count < settings.minReviews
      ? { metric: 'customer-rating', kind: 'no-data' }
      : scored('customer-rating', scoreHigher(rating.averageHundredths, settings.customerRating)),
    rateMetric('lost-disputes', input.lostDisputes, settings.lostDisputes, settings.minOrders),
    input.reports === null
      ? { metric: 'reports', kind: 'no-data' }
      : scored('reports', scoreLower(input.reports.count, settings.reports)),
  ];

  const formulaVersion = SELLER_HEALTH_FORMULA_VERSION;
  if (input.orders < settings.minOrders) return { kind: 'new', metrics, formulaVersion };

  let lowest: { metric: SellerHealthMetric; score: number } | null = null;
  for (const m of metrics) {
    if (m.kind === 'scored' && (lowest === null || m.score < lowest.score)) {
      lowest = { metric: m.metric, score: m.score };
    }
  }
  if (lowest === null) return { kind: 'no-data', metrics, formulaVersion };
  return {
    kind: 'scored',
    band: bandOfScore(lowest.score),
    score: lowest.score,
    lowestMetric: lowest.metric,
    metrics,
    formulaVersion,
  };
}
