import { minorUnitExponent, money, Temporal } from '@mondapac/shared-kernel';
import type { MarketId, Money } from '@mondapac/shared-kernel';

/** Which way a regular price may move before it is held for review (VER-03, brief Q9). */
export type JumpDirections = 'up' | 'down' | 'both';

/**
 * The per-Market numbers of pricing (pricing design 2.2, 4.6): read by pricing only, with no
 * default. The threshold is the exact fraction `thresholdNumerator / thresholdDenominator`
 * (ADR-0007 decision 2), never a float. Resolved by a `PricingPolicyProvider` (a later part);
 * a Vertical override plugs in there without changing callers.
 */
export interface PricingPolicy {
  /** Only `createPricingPolicy` makes one: a literal does not type-check (brand). */
  readonly __pricingPolicy: true;
  /** The Market this policy belongs to; a series refuses another Market's policy. */
  readonly marketId: MarketId;
  /** The Market currency: every price is in it (ADR-0002 decision 4). */
  readonly currency: string;
  /** The most one unit may cost, in the Market currency (brief Q10). */
  readonly maxUnitPrice: Money;
  readonly thresholdNumerator: bigint;
  readonly thresholdDenominator: bigint;
  readonly jumpDirections: JumpDirections;
  /** The jump window W in whole milliseconds: how far back the anchor of design 2.4 looks. */
  readonly jumpWindowMs: number;
}

export type PricingPolicyError =
  | { readonly code: 'pricing-policy.currency-invalid' }
  | { readonly code: 'pricing-policy.max-unit-price-invalid' }
  | { readonly code: 'pricing-policy.threshold-invalid' }
  | { readonly code: 'pricing-policy.directions-invalid' }
  | { readonly code: 'pricing-policy.window-invalid' };

export class InvalidPricingPolicyError extends Error {
  constructor(readonly reason: PricingPolicyError) {
    super(`invalid pricing policy: ${reason.code}`);
    this.name = 'InvalidPricingPolicyError';
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_FRACTION_PART = 2n ** 31n;
const MAX_WINDOW_HOURS = 24 * 90;

export interface PricingPolicyInput {
  readonly marketId: MarketId;
  readonly currency: string;
  /** Minor units of `currency`. */
  readonly maxUnitPriceMinor: bigint;
  readonly thresholdNumerator: bigint;
  readonly thresholdDenominator: bigint;
  readonly jumpDirections: string;
  /** An ISO 8601 duration made of days, hours and minutes only, such as `P7D`. */
  readonly jumpWindow: string;
}

/**
 * Builds a policy from configuration and refuses anything that is not safe: the maximum is
 * positive and at most 2^53 - 1 (brief s5), the threshold is a fraction in (0, 1], the window
 * is between one hour and 90 days. Throws `InvalidPricingPolicyError`, because a bad policy is
 * a boot-time configuration error, never a request outcome.
 */
export function createPricingPolicy(input: PricingPolicyInput): PricingPolicy {
  let exponentOk = true;
  try {
    minorUnitExponent(input.currency);
  } catch {
    exponentOk = false;
  }
  if (!exponentOk) throw new InvalidPricingPolicyError({ code: 'pricing-policy.currency-invalid' });
  if (
    typeof input.maxUnitPriceMinor !== 'bigint' ||
    input.maxUnitPriceMinor < 1n ||
    input.maxUnitPriceMinor > MAX_SAFE
  ) {
    throw new InvalidPricingPolicyError({ code: 'pricing-policy.max-unit-price-invalid' });
  }
  const { thresholdNumerator: n, thresholdDenominator: d } = input;
  if (
    typeof n !== 'bigint' ||
    typeof d !== 'bigint' ||
    n < 1n ||
    d < 1n ||
    n > d ||
    d > MAX_FRACTION_PART
  ) {
    throw new InvalidPricingPolicyError({ code: 'pricing-policy.threshold-invalid' });
  }
  if (
    input.jumpDirections !== 'up' &&
    input.jumpDirections !== 'down' &&
    input.jumpDirections !== 'both'
  ) {
    throw new InvalidPricingPolicyError({ code: 'pricing-policy.directions-invalid' });
  }
  let window: Temporal.Duration;
  try {
    window = Temporal.Duration.from(input.jumpWindow);
  } catch {
    throw new InvalidPricingPolicyError({ code: 'pricing-policy.window-invalid' });
  }
  if (
    window.years !== 0 ||
    window.months !== 0 ||
    window.weeks !== 0 ||
    window.seconds !== 0 ||
    window.milliseconds !== 0 ||
    window.microseconds !== 0 ||
    window.nanoseconds !== 0
  ) {
    throw new InvalidPricingPolicyError({ code: 'pricing-policy.window-invalid' });
  }
  const hours = window.days * 24 + window.hours + window.minutes / 60;
  if (window.sign < 0 || hours < 1 || hours > MAX_WINDOW_HOURS) {
    throw new InvalidPricingPolicyError({ code: 'pricing-policy.window-invalid' });
  }
  return Object.freeze({
    __pricingPolicy: true as const,
    marketId: input.marketId,
    currency: input.currency,
    maxUnitPrice: money(input.maxUnitPriceMinor, input.currency),
    thresholdNumerator: n,
    thresholdDenominator: d,
    jumpDirections: input.jumpDirections,
    jumpWindowMs: Math.round(hours * 3_600_000),
  });
}

/** The instant `window` before `now`. */
export function windowStart(now: Temporal.Instant, policy: PricingPolicy): Temporal.Instant {
  return now.subtract({ milliseconds: policy.jumpWindowMs });
}
