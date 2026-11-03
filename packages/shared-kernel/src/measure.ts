/**
 * Number-with-unit values (attributes A3, plan decision ت۱). A measure is stored as its value in
 * the dimension's base unit plus the unit the seller chose, so a product can be sorted, filtered
 * and compared across units while the page still shows what the seller typed ("0.5 kg", not
 * "500 g"). All arithmetic is on decimal text with BigInt: no floating point reaches a stored
 * value.
 */

export const MEASURE_DIMENSIONS = ['mass', 'volume', 'length', 'count'] as const;
export type MeasureDimension = (typeof MEASURE_DIMENSIONS)[number];

export interface MeasureUnit {
  readonly code: string;
  readonly dimension: MeasureDimension;
  /** How many base units one of this unit is. Always a whole number, so a conversion is exact. */
  readonly factor: number;
}

/**
 * The units the platform knows (physical facts, not Market settings). A Market lists the subset
 * it offers, with labels, under `catalog.units`. Base units: g, ml, mm, count.
 */
export const MEASURE_UNITS: readonly MeasureUnit[] = Object.freeze([
  { code: 'g', dimension: 'mass', factor: 1 },
  { code: 'kg', dimension: 'mass', factor: 1000 },
  { code: 'ml', dimension: 'volume', factor: 1 },
  { code: 'l', dimension: 'volume', factor: 1000 },
  { code: 'mm', dimension: 'length', factor: 1 },
  { code: 'cm', dimension: 'length', factor: 10 },
  { code: 'm', dimension: 'length', factor: 1000 },
  { code: 'count', dimension: 'count', factor: 1 },
]);

export const MEASURE_BASE_UNITS: Readonly<Record<MeasureDimension, string>> = Object.freeze({
  mass: 'g',
  volume: 'ml',
  length: 'mm',
  count: 'count',
});

/** The most decimal places an administrator may allow (a seller types at most this many). */
export const MEASURE_DECIMALS_MAX = 6;

/** Digits kept in check: a value longer than this is refused before any arithmetic. */
const MAX_INTEGER_DIGITS = 12;
const MAX_FRACTION_DIGITS = 9;
const NON_NEGATIVE_DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

export function measureUnit(code: string): MeasureUnit | undefined {
  return MEASURE_UNITS.find((unit) => unit.code === code);
}

/** The settings of a `measure` field: what the administrator chose for one attribute. */
export interface MeasureSettings {
  readonly dimension: MeasureDimension;
  /** Unit codes a seller may pick, all of `dimension`; the default is one of them. */
  readonly units: readonly string[];
  readonly defaultUnit: string;
  /** Decimal places allowed in the unit the seller picked, 0 to {@link MEASURE_DECIMALS_MAX}. */
  readonly decimals: number;
}

/** A stored measure: `value` is decimal text in the base unit, `unit` is the seller's choice. */
export interface MeasureValue {
  readonly value: string;
  readonly unit: string;
}

interface Scaled {
  /** The number times 10^scale, as a whole number. */
  readonly digits: bigint;
  readonly scale: number;
}

function parseScaled(text: string): Scaled | null {
  const match = NON_NEGATIVE_DECIMAL.exec(text);
  if (match === null) return null;
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (whole.length > MAX_INTEGER_DIGITS || fraction.length > MAX_FRACTION_DIGITS) return null;
  return { digits: BigInt(whole + fraction), scale: fraction.length };
}

function render(digits: bigint, scale: number): string {
  if (scale === 0) return digits.toString();
  const padded = digits.toString().padStart(scale + 1, '0');
  const whole = padded.slice(0, padded.length - scale);
  const fraction = padded.slice(padded.length - scale).replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

/** How many decimal places a plain decimal text has, or null when it is not a plain decimal. */
export function decimalPlaces(text: string): number | null {
  const scaled = parseScaled(text);
  if (scaled === null) return null;
  // Trailing zeros do not count as places ("2.50" has one).
  const fraction = text.split('.')[1] ?? '';
  return fraction.replace(/0+$/, '').length;
}

/**
 * What the seller typed, in the unit picked, as the stored base-unit text; `null` when the text
 * is not a plain non-negative decimal, the unit is unknown, or it has more decimal places than
 * `decimals`. Exact: "0.5" kg is "500", "1.25" l is "1250".
 */
export function measureToBase(entered: string, unit: string, decimals: number): string | null {
  const known = measureUnit(unit);
  const scaled = parseScaled(entered);
  if (known === undefined || scaled === null) return null;
  const places = decimalPlaces(entered);
  if (places === null || places > decimals) return null;
  return render(scaled.digits * BigInt(known.factor), scaled.scale);
}

/**
 * A stored base-unit text shown in `unit`, rounded half up to `decimals` places with trailing
 * zeros dropped ("500" g in kg is "0.5"). `null` when either input is not valid. A value a seller
 * saved passes this unchanged, because validation refuses more places than `decimals`.
 */
export function measureFromBase(base: string, unit: string, decimals: number): string | null {
  const known = measureUnit(unit);
  const scaled = parseScaled(base);
  if (known === undefined || scaled === null) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MEASURE_DECIMALS_MAX) return null;
  // value / factor, kept as numerator / (10^scale * factor), rounded at `decimals` places.
  const denominator = 10n ** BigInt(scaled.scale) * BigInt(known.factor);
  const numerator = scaled.digits * 10n ** BigInt(decimals);
  const quotient = numerator / denominator;
  const rounded = (numerator % denominator) * 2n >= denominator ? quotient + 1n : quotient;
  return render(rounded, decimals);
}

/** True when `value` has exactly the two text members of a stored measure. */
export function isMeasureValue(value: unknown): value is MeasureValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2) return false;
  return typeof record['value'] === 'string' && typeof record['unit'] === 'string';
}

/** The reasons {@link checkMeasure} gives; the schema maps each to an issue code. */
export type MeasureProblem = 'type' | 'unit-unknown' | 'precision';

/**
 * Checks the shape, the unit and the decimal places of a measure value: a decimal text in base
 * units, a unit the field offers, and a value that shows in that unit with no more than
 * `decimals` places. Bounds (min, max) are in base units and are the caller's to compare.
 */
export function checkMeasure(settings: MeasureSettings, value: unknown): MeasureProblem | null {
  if (!isMeasureValue(value)) return 'type';
  if (parseScaled(value.value) === null) return 'type';
  if (!settings.units.includes(value.unit)) return 'unit-unknown';
  const shown = measureFromBase(value.value, value.unit, MEASURE_DECIMALS_MAX);
  if (shown === null) return 'type';
  const places = decimalPlaces(shown);
  // The base text must be exactly representable in the unit with at most `decimals` places.
  const exact = measureToBase(shown, value.unit, MEASURE_DECIMALS_MAX);
  if (places === null || exact === null || Number(exact) !== Number(value.value)) {
    return 'precision';
  }
  return places > settings.decimals ? 'precision' : null;
}
