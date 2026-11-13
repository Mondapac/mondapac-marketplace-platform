// The attribute and price filters of a listing that reads the API (attributes A7, variants V8). They
// live in the URL in the API's own words, so a filtered page can be shared and its link handed to
// `GET search/products` as it is:
//   filter=<attribute>:<code>[,<code>...]   one parameter per attribute (a toggle's code is `true`)
//   price=<min>..<max>                      whole minor units of the Market currency, either end open
// The shape is checked here like the API checks it; which attributes are filters of the category
// is the API's answer, so an unknown one simply matches nothing there.

import type { Money, PriceBand } from '../storefront/types.ts';

export interface LiveChoice {
  readonly attr: string;
  /** Option codes, sorted, each once. */
  readonly values: readonly string[];
}

export interface LivePrice {
  /** Minor units, or null for an open end. */
  readonly min: number | null;
  readonly max: number | null;
}

export interface LiveFilters {
  /** Sorted by attribute code. */
  readonly choices: readonly LiveChoice[];
  readonly price: LivePrice | null;
}

export const NO_LIVE_FILTERS: LiveFilters = { choices: [], price: null };

/** The API's limits (search-filter.ts): at most 8 attributes, 50 codes each. */
export const MAX_LIVE_CHOICES = 8;
export const MAX_LIVE_VALUES = 50;
const CODE = /^[a-z][a-z0-9_-]{0,63}$/u;
const VALUE = /^[a-z0-9][a-z0-9_-]{0,79}$/u;
const MINOR = /^[0-9]{1,13}$/u;
/** The highest price bound the API takes (ten billion in major units, two decimals). */
const MAX_MINOR = 1_000_000_000_000;

type Query = Record<string, string | string[] | undefined>;

const listOf = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** One `filter` value, or null when it is not one the API would take. */
function choiceOf(raw: string): LiveChoice | null {
  const colon = raw.indexOf(':');
  if (colon < 1) return null;
  const attr = raw.slice(0, colon);
  if (!CODE.test(attr)) return null;
  const values = [...new Set(raw.slice(colon + 1).split(','))].sort();
  if (values.length === 0 || values.length > MAX_LIVE_VALUES) return null;
  return values.every((v) => VALUE.test(v)) ? { attr, values } : null;
}

/** A `price` value in minor units (`<min>..<max>`), or null. A sample band id is not one. */
export function livePriceOf(raw: string | string[] | undefined): LivePrice | null {
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (text === undefined) return null;
  const bounds = text.split('..');
  if (bounds.length !== 2) return null;
  const [low = '', high = ''] = bounds;
  if (low === '' && high === '') return null;
  if ((low !== '' && !MINOR.test(low)) || (high !== '' && !MINOR.test(high))) return null;
  const min = low === '' ? null : Number(low);
  const max = high === '' ? null : Number(high);
  if ((min ?? 0) > MAX_MINOR || (max ?? 0) > MAX_MINOR) return null;
  if (min !== null && max !== null && min > max) return null;
  return { min, max };
}

/**
 * The live filters of a URL query. A malformed `filter` value and a second one for the same
 * attribute are dropped (not refused), so an edited link still lists something.
 */
export function liveFiltersOf(query: Query): LiveFilters {
  const byAttr = new Map<string, LiveChoice>();
  for (const raw of listOf(query.filter)) {
    const choice = choiceOf(raw);
    if (choice !== null && !byAttr.has(choice.attr)) byAttr.set(choice.attr, choice);
  }
  const choices = [...byAttr.values()]
    .sort((a, b) => (a.attr < b.attr ? -1 : a.attr > b.attr ? 1 : 0))
    .slice(0, MAX_LIVE_CHOICES);
  return { choices, price: livePriceOf(query.price) };
}

export function liveFilterCount(filters: LiveFilters): number {
  return filters.choices.reduce((n, c) => n + c.values.length, 0) + (filters.price ? 1 : 0);
}

/** The price as the API's `price` text. */
export function priceParam(price: LivePrice): string {
  return `${price.min ?? ''}..${price.max ?? ''}`;
}

/** The `filter` and `price` parameters of the filters, in one order. */
export function liveParams(filters: LiveFilters): [string, string][] {
  return [
    ...filters.choices.map((c): [string, string] => ['filter', `${c.attr}:${c.values.join(',')}`]),
    ...(filters.price === null ? [] : [['price', priceParam(filters.price)] as [string, string]]),
  ];
}

/**
 * The listing's address with the live filters added to the query already on `path` (the search
 * words, `direct=1`). `listingHref` keeps that query first, so pages and the sort keep the filters.
 */
export function withLiveParams(path: string, filters: LiveFilters): string {
  const params = liveParams(filters);
  if (params.length === 0) return path;
  const [base = path, fixed] = path.split('?', 2);
  const query = new URLSearchParams(fixed);
  for (const [key, value] of params) query.append(key, value);
  return `${base}?${query.toString()}`;
}

/** The filters with one option code of an attribute picked or dropped. */
export function withChoice(
  filters: LiveFilters,
  attr: string,
  code: string,
  on: boolean,
): LiveFilters {
  const current = filters.choices.find((c) => c.attr === attr)?.values ?? [];
  const values = on ? [...new Set([...current, code])].sort() : current.filter((v) => v !== code);
  const others = filters.choices.filter((c) => c.attr !== attr);
  const choices = values.length === 0 ? others : [...others, { attr, values }];
  return {
    ...filters,
    choices: choices.sort((a, b) => (a.attr < b.attr ? -1 : a.attr > b.attr ? 1 : 0)),
  };
}

export function withLivePrice(filters: LiveFilters, price: LivePrice | null): LiveFilters {
  return { ...filters, price };
}

/** The price bands a live listing offers, in major units of the currency (each a whole step). */
const BAND_STEPS = [10, 25, 50, 100] as const;

/** The minor units in one major unit of a currency (100 for AUD, 1 for JPY, 1000 for KWD). */
export function minorPerMajor(currency: string): number {
  const digits =
    new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  return 10 ** digits;
}

export interface LivePriceBand {
  /** For the label (`priceBandLabel`). */
  readonly band: PriceBand;
  readonly price: LivePrice;
}

/**
 * "Under 10", "10 to 25", "25 to 50", "50 to 100" and "Over 100" in the listing's currency, as
 * price ranges in minor units. The bounds are inclusive at the API, so "Under 10" ends one minor
 * unit below 10 and "Over 100" starts one above.
 */
export function livePriceBands(currency: string): readonly LivePriceBand[] {
  const unit = minorPerMajor(currency);
  const money = (major: number): Money => ({ amount: major * unit, currency });
  const steps = BAND_STEPS.map((major) => major * unit);
  const first = steps[0] ?? unit;
  const last = steps.at(-1) ?? unit;
  const bands: LivePriceBand[] = [
    {
      band: { id: `..${first - 1}`, below: money(BAND_STEPS[0]) },
      price: { min: null, max: first - 1 },
    },
  ];
  for (let i = 1; i < steps.length; i += 1) {
    const from = steps[i - 1] ?? 0;
    const to = steps[i] ?? 0;
    bands.push({
      band: {
        id: `${from}..${to}`,
        from: money(BAND_STEPS[i - 1] ?? 0),
        to: money(BAND_STEPS[i] ?? 0),
      },
      price: { min: from, max: to },
    });
  }
  bands.push({
    band: { id: `${last + 1}..`, above: money(BAND_STEPS.at(-1) ?? 0) },
    price: { min: last + 1, max: null },
  });
  return bands;
}

export const samePrice = (a: LivePrice | null, b: LivePrice | null): boolean =>
  a === null || b === null ? a === b : a.min === b.min && a.max === b.max;
