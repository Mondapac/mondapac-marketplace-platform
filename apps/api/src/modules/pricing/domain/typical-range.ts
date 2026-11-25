import type { ReferencePrice } from './reference-price';

/**
 * The "Typical price" a seller sees on the Offer page (offer page design, section 6; R4 of the
 * risk-based Offer approval). Only a range, never the median and never one seller's price: the
 * edges are the reference moved by the Market's band, then bucketed and rounded OUTWARD to two
 * significant digits (at least 10 minor units), so the exact median cannot be read back from the two
 * numbers (design 9; Hassan). Minor
 * units of the Market currency, exact integer arithmetic only (ADR-0007 decision 2).
 */
export interface TypicalRange {
  readonly lowMinor: bigint;
  readonly highMinor: bigint;
}

/**
 * The step of a rounding: two significant digits, but never finer than 10 minor units, so a small
 * price (a median under about 200 minor units) is hidden too (Hassan, PR 1343 finding 1).
 */
function stepOf(value: bigint): bigint {
  const digits = value.toString().length;
  return digits <= 3 ? 10n : 10n ** BigInt(digits - 2);
}

function floorTo(value: bigint): bigint {
  const step = stepOf(value);
  const floored = (value / step) * step;
  return floored < 1n ? 1n : floored;
}

function ceilTo(value: bigint): bigint {
  const step = stepOf(value);
  return ((value + step - 1n) / step) * step;
}

/** The reference moved to the nearest step (half up), so the band is not centred on the median. */
function bucketDoubled(doubledMinor: bigint): bigint {
  const whole = (doubledMinor + 1n) / 2n;
  const step = stepOf(whole);
  const bucket = ((whole + step / 2n) / step) * step;
  return (bucket < 1n ? 1n : bucket) * 2n;
}

/**
 * The range of a reference under `bandPercent`: the reference is first bucketed (nearest step of
 * two significant digits, at least 10 minor units), then moved down and up by the band, then each
 * edge is widened outward with the same step. At least 1 minor unit.
 */
export function typicalRange(reference: ReferencePrice, bandPercent: number): TypicalRange {
  if (!Number.isSafeInteger(bandPercent) || bandPercent < 1) {
    throw new RangeError('typical range: the band must be a positive whole percent');
  }
  const band = BigInt(bandPercent);
  const doubled = bucketDoubled(reference.doubledMinor);
  const lowRaw = band >= 100n ? 1n : (doubled * (100n - band)) / 200n;
  const highRaw = (doubled * (100n + band) + 199n) / 200n;
  return { lowMinor: floorTo(lowRaw), highMinor: ceilTo(highRaw) };
}
