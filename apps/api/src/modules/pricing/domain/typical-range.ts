import type { ReferencePrice } from './reference-price';

/**
 * The "Typical price" a seller sees on the Offer page (offer page design, section 6; R4 of the
 * risk-based Offer approval). Only a range, never the median and never one seller's price: the
 * edges are the reference moved by the Market's band, then rounded OUTWARD to two significant
 * digits, so the exact median cannot be read back from the two numbers (design 9; Hassan). Minor
 * units of the Market currency, exact integer arithmetic only (ADR-0007 decision 2).
 */
export interface TypicalRange {
  readonly lowMinor: bigint;
  readonly highMinor: bigint;
}

/** Rounds down to two significant digits (at least 1). */
function floorTwoDigits(value: bigint): bigint {
  const digits = value.toString().length;
  if (digits <= 2) return value < 1n ? 1n : value;
  const step = 10n ** BigInt(digits - 2);
  return (value / step) * step;
}

/** Rounds up to two significant digits. */
function ceilTwoDigits(value: bigint): bigint {
  const digits = value.toString().length;
  if (digits <= 2) return value;
  const step = 10n ** BigInt(digits - 2);
  return ((value + step - 1n) / step) * step;
}

/**
 * The range of a reference under `bandPercent`: from `reference * (100 - band) / 100` (at least 1
 * minor unit) up to `reference * (100 + band) / 100`, widened outward to two significant digits.
 * The exact edges use `doubledMinor` (the median is a half-unit exact fraction), so no rounding
 * happens before the widening.
 */
export function typicalRange(reference: ReferencePrice, bandPercent: number): TypicalRange {
  if (!Number.isSafeInteger(bandPercent) || bandPercent < 1) {
    throw new RangeError('typical range: the band must be a positive whole percent');
  }
  const band = BigInt(bandPercent);
  const lowRaw = band >= 100n ? 1n : (reference.doubledMinor * (100n - band)) / 200n;
  const highRaw = (reference.doubledMinor * (100n + band) + 199n) / 200n;
  return { lowMinor: floorTwoDigits(lowRaw), highMinor: ceilTwoDigits(highRaw) };
}
