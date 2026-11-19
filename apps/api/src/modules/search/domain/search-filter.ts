import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';

/**
 * Attribute filters of a listing (attributes A7). A URL names them with option codes, never labels:
 * `filter=<attribute>:<code>[,<code>...]` (a choice, or a yes switch with `true`) and
 * `range=<attribute>:<min>..<max>` (either end may be left out). Values of one attribute are OR-ed,
 * attributes are AND-ed. The request is checked here for shape only; which attributes are filters
 * of the category is catalog's answer.
 */
export const MAX_CHOICE_FILTERS = 8;
export const MAX_RANGE_FILTERS = 3;
export const MAX_VALUES_PER_FILTER = 50;
const MAX_FILTER_PARAMS = 20;

const CODE = /^[a-z][a-z0-9_-]{0,63}$/;
const VALUE = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const NUMBER = /^-?[0-9]{1,15}(\.[0-9]{1,9})?$/;

export interface ChoiceFilter {
  readonly attr: string;
  readonly values: readonly string[];
}

export interface RangeFilter {
  readonly attr: string;
  /** Decimal text, or null for no lower bound. */
  readonly min: string | null;
  readonly max: string | null;
}

/** What the visitor asked, checked for shape. */
export interface ParsedFilters {
  readonly choices: readonly ChoiceFilter[];
  readonly ranges: readonly RangeFilter[];
}

export const NO_FILTERS: ParsedFilters = { choices: [], ranges: [] };

export interface FilterRequest {
  readonly filter?: string | readonly string[] | undefined;
  readonly range?: string | readonly string[] | undefined;
}

export interface FilterValidationFailed {
  readonly path: string;
  readonly code: string;
}

const asList = (value: unknown): readonly unknown[] | null =>
  value === undefined ? [] : Array.isArray(value) ? (value as unknown[]) : [value];

/** Checks the `filter` and `range` parameters (pure). */
export function parseFilters(
  request: FilterRequest,
): Result<ParsedFilters, FilterValidationFailed> {
  const filterParams = asList(request.filter);
  const rangeParams = asList(request.range);
  if (filterParams === null || rangeParams === null) return err({ path: 'filter', code: 'format' });
  if (filterParams.length + rangeParams.length > MAX_FILTER_PARAMS) {
    return err({ path: 'filter', code: 'too-many' });
  }
  const seen = new Set<string>();
  const choices: ChoiceFilter[] = [];
  for (const raw of filterParams) {
    if (typeof raw !== 'string') return err({ path: 'filter', code: 'format' });
    const colon = raw.indexOf(':');
    const attr = colon < 0 ? '' : raw.slice(0, colon);
    if (!CODE.test(attr)) return err({ path: 'filter', code: 'format' });
    if (seen.has(attr)) return err({ path: 'filter', code: 'repeated' });
    seen.add(attr);
    const values = [...new Set(raw.slice(colon + 1).split(','))];
    if (values.length > MAX_VALUES_PER_FILTER) return err({ path: 'filter', code: 'too-many' });
    if (values.some((value) => !VALUE.test(value))) return err({ path: 'filter', code: 'format' });
    choices.push({ attr, values });
  }
  const ranges: RangeFilter[] = [];
  for (const raw of rangeParams) {
    if (typeof raw !== 'string') return err({ path: 'range', code: 'format' });
    const colon = raw.indexOf(':');
    const attr = colon < 0 ? '' : raw.slice(0, colon);
    if (!CODE.test(attr)) return err({ path: 'range', code: 'format' });
    if (seen.has(attr)) return err({ path: 'range', code: 'repeated' });
    seen.add(attr);
    const bounds = raw.slice(colon + 1).split('..');
    if (bounds.length !== 2) return err({ path: 'range', code: 'format' });
    const [low = '', high = ''] = bounds;
    if ((low !== '' && !NUMBER.test(low)) || (high !== '' && !NUMBER.test(high))) {
      return err({ path: 'range', code: 'format' });
    }
    if (low === '' && high === '') return err({ path: 'range', code: 'format' });
    if (low !== '' && high !== '' && Number(low) > Number(high)) {
      return err({ path: 'range', code: 'order' });
    }
    ranges.push({ attr, min: low === '' ? null : low, max: high === '' ? null : high });
  }
  if (choices.length > MAX_CHOICE_FILTERS) return err({ path: 'filter', code: 'too-many' });
  if (ranges.length > MAX_RANGE_FILTERS) return err({ path: 'range', code: 'too-many' });
  return ok({ choices, ranges });
}

/** The facet strings of a choice filter: a value of an attribute is `attribute=value`. */
export const facetCode = (attr: string, value: string): string => `${attr}=${value}`;

/** Splits `attribute=value`; null when it is not one. */
export function splitFacet(code: string): { attr: string; value: string } | null {
  const at = code.indexOf('=');
  return at < 1 ? null : { attr: code.slice(0, at), value: code.slice(at + 1) };
}

/**
 * Whether a document's facets satisfy every choice filter except the one named (pure): the counts
 * of an attribute's own options ignore its own filter, so picking one value does not hide its
 * siblings.
 */
export function matchesChoices(
  facets: readonly string[],
  choices: readonly ChoiceFilter[],
  except?: string,
): boolean {
  const held = new Set(facets);
  return choices.every(
    (choice) =>
      choice.attr === except ||
      choice.values.some((value) => held.has(facetCode(choice.attr, value))),
  );
}

/**
 * The price filter (variants V8): `price=<min>..<max>` in the Market currency's minor units (either
 * end may be left out). It reads the buyer price of the sell units that match the other filters and
 * are in stock, never a price the product does not sell at now.
 */
export interface PriceRange {
  readonly min: bigint | null;
  readonly max: bigint | null;
}

/** The highest price bound accepted, in minor units (ten billion in major units). */
export const MAX_PRICE_MINOR = 1_000_000_000_000n;
const MINOR = /^[0-9]{1,13}$/;

/** Checks the `price` parameter (pure); absent or empty is no price filter. */
export function parsePrice(raw: unknown): Result<PriceRange | null, FilterValidationFailed> {
  if (raw === undefined || raw === '') return ok(null);
  if (typeof raw !== 'string') return err({ path: 'price', code: 'format' });
  const bounds = raw.split('..');
  if (bounds.length !== 2) return err({ path: 'price', code: 'format' });
  const [low = '', high = ''] = bounds;
  if ((low !== '' && !MINOR.test(low)) || (high !== '' && !MINOR.test(high))) {
    return err({ path: 'price', code: 'format' });
  }
  if (low === '' && high === '') return err({ path: 'price', code: 'format' });
  const min = low === '' ? null : BigInt(low);
  const max = high === '' ? null : BigInt(high);
  if ((min !== null && min > MAX_PRICE_MINOR) || (max !== null && max > MAX_PRICE_MINOR)) {
    return err({ path: 'price', code: 'range' });
  }
  if (min !== null && max !== null && min > max) return err({ path: 'price', code: 'order' });
  return ok({ min, max });
}
