import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';

// Tax strategies: how the tax of one order line is worked out. A strategy is plain data an admin
// defines (never code), so a rule the tax adviser names becomes a configuration, not a release.
// Rates are whole basis points (1000 = 10 %); amounts are integer minor units; no floats.

export type TaxStrategyKind = 'flat-rate' | 'by-category';

export const TAX_STRATEGY_KINDS: readonly TaxStrategyKind[] = ['flat-rate', 'by-category'];

/** The highest rate a strategy may name (50 %). */
export const MAX_RATE_BPS = 5000;
export const MAX_CATEGORY_RATES = 20;
export const MAX_NAME_LENGTH = 80;

/** One rate for every line. */
export interface FlatRateParams {
  readonly kind: 'flat-rate';
  readonly rateBps: number;
}

/** A rate per tax category of the Market; a line in no listed category takes `defaultRateBps`. */
export interface ByCategoryParams {
  readonly kind: 'by-category';
  readonly defaultRateBps: number;
  readonly categoryRatesBps: Readonly<Record<string, number>>;
}

export type TaxStrategyParams = FlatRateParams | ByCategoryParams;

export interface StrategyDraft {
  readonly name: string;
  readonly params: TaxStrategyParams;
}

export interface FieldIssue {
  readonly path: string;
  readonly code: string;
}

const isRate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_RATE_BPS;

/**
 * Checks what an admin sent and builds the strategy, or lists every field at fault. A category
 * must be one of the Market's tax category codes (`categoryCodes`).
 */
export function parseStrategyDraft(
  input: unknown,
  categoryCodes: readonly string[],
): Result<StrategyDraft, readonly FieldIssue[]> {
  const issues: FieldIssue[] = [];
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name.length < 1 || name.length > MAX_NAME_LENGTH || /\p{C}/u.test(name)) {
    issues.push({ path: 'name', code: 'length' });
  }

  let params: TaxStrategyParams | null = null;
  if (raw.kind === 'flat-rate') {
    if (isRate(raw.rateBps)) params = { kind: 'flat-rate', rateBps: raw.rateBps };
    else issues.push({ path: 'rateBps', code: 'range' });
  } else if (raw.kind === 'by-category') {
    const defaultOk = isRate(raw.defaultRateBps);
    if (!defaultOk) issues.push({ path: 'defaultRateBps', code: 'range' });
    const table = raw.categoryRatesBps;
    const rates: Record<string, number> = {};
    if (typeof table !== 'object' || table === null || Array.isArray(table)) {
      issues.push({ path: 'categoryRatesBps', code: 'type' });
    } else {
      const entries = Object.entries(table);
      if (entries.length > MAX_CATEGORY_RATES) {
        issues.push({ path: 'categoryRatesBps', code: 'range' });
      }
      for (const [code, rate] of entries.slice(0, MAX_CATEGORY_RATES)) {
        const path = `categoryRatesBps.${code.slice(0, 32).replace(/\p{C}/gu, '�')}`;
        if (!categoryCodes.includes(code)) issues.push({ path, code: 'unknown-category' });
        else if (!isRate(rate)) issues.push({ path, code: 'range' });
        else rates[code] = rate;
      }
    }
    if (defaultOk && issues.length === 0) {
      params = {
        kind: 'by-category',
        defaultRateBps: raw.defaultRateBps as number,
        categoryRatesBps: rates,
      };
    }
  } else {
    issues.push({ path: 'kind', code: 'enum' });
  }

  if (issues.length > 0 || params === null) return err(issues);
  return ok({ name, params });
}

/** The strategy as stored in the `config` column (the kind has its own column). */
export function paramsToConfig(params: TaxStrategyParams): Record<string, unknown> {
  return params.kind === 'flat-rate'
    ? { rateBps: params.rateBps }
    : { defaultRateBps: params.defaultRateBps, categoryRatesBps: { ...params.categoryRatesBps } };
}

/** Rebuilds the strategy from a stored row; null when the stored shape is not valid (fail closed). */
export function paramsFromStored(kind: string, config: unknown): TaxStrategyParams | null {
  const raw = (typeof config === 'object' && config !== null ? config : {}) as Record<
    string,
    unknown
  >;
  if (kind === 'flat-rate' && isRate(raw.rateBps)) return { kind, rateBps: raw.rateBps };
  if (kind === 'by-category' && isRate(raw.defaultRateBps)) {
    const table = raw.categoryRatesBps;
    if (typeof table !== 'object' || table === null || Array.isArray(table)) return null;
    const rates: Record<string, number> = {};
    for (const [code, rate] of Object.entries(table)) {
      if (!isRate(rate)) return null;
      rates[code] = rate;
    }
    return { kind, defaultRateBps: raw.defaultRateBps, categoryRatesBps: rates };
  }
  return null;
}

/** The rate for a line in `categoryCode` (null when the line has no category). */
export function rateFor(params: TaxStrategyParams, categoryCode: string | null): number {
  if (params.kind === 'flat-rate') return params.rateBps;
  const own = categoryCode === null ? undefined : params.categoryRatesBps[categoryCode];
  return own ?? params.defaultRateBps;
}

export interface TaxableLine {
  /** The line amount in minor units, never negative. */
  readonly amount: bigint;
  /** True when `amount` already contains the tax (AU prices are GST-inclusive). */
  readonly taxInclusive: boolean;
  readonly categoryCode: string | null;
}

export interface LineTax {
  readonly rateBps: number;
  readonly tax: bigint;
  /** Without tax. */
  readonly net: bigint;
  /** With tax: `net + tax`. */
  readonly gross: bigint;
}

/** `numerator / denominator` rounded half up, for non-negative integers. */
const divideHalfUp = (numerator: bigint, denominator: bigint): bigint =>
  (2n * numerator + denominator) / (2n * denominator);

/**
 * The tax of one line, rounded half up per line. Inclusive: the tax inside the amount
 * (`amount × r / (1 + r)`); exclusive: the tax on top of it (`amount × r`).
 */
export function computeLineTax(line: TaxableLine, params: TaxStrategyParams): LineTax {
  const rateBps = rateFor(params, line.categoryCode);
  const rate = BigInt(rateBps);
  if (line.taxInclusive) {
    const tax = divideHalfUp(line.amount * rate, 10_000n + rate);
    return { rateBps, tax, net: line.amount - tax, gross: line.amount };
  }
  const tax = divideHalfUp(line.amount * rate, 10_000n);
  return { rateBps, tax, net: line.amount, gross: line.amount + tax };
}
