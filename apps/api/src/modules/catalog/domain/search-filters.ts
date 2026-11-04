import { BRAND_FACET, ORIGIN_ATTRIBUTE, type LoadedSearchDefinition } from './search-attributes';
import { countryName } from './iso-countries';

/** How a filter is shown and read: a choice of values, a number range, or a yes switch. */
export type SearchFilterKind = 'choice' | 'range' | 'toggle';

export interface SearchFilterOption {
  /** The option code (lower case); the URL and the index use it, never the label. */
  readonly code: string;
  /** The label in the asked locale, English fallback. */
  readonly label: string;
}

/**
 * One filter of a listing (attributes A7). `choice` offers `options` (several may be picked: values
 * of one attribute are OR-ed, attributes are AND-ed), `range` reads a number between two bounds,
 * `toggle` is "only yes". Merged options are not offered; archived and draft attributes are not
 * offered. The brand and the country of origin are the two global filters (no category).
 */
export interface SearchFilterDefinition {
  readonly code: string;
  readonly name: string;
  readonly kind: SearchFilterKind;
  readonly options: readonly SearchFilterOption[];
  /**
   * Option codes of merged options that now stand for another option: a URL written before the
   * merge still names the old code (attributes A8, read-time mapping).
   */
  readonly redirects: Readonly<Record<string, string>>;
}

/** The most options one filter offers (a definition holds at most 200; the brand list is capped). */
export const MAX_FILTER_OPTIONS = 250;

/** The data types a buyer can filter by (attributes plan, decision ت۸). */
const KIND_OF: Readonly<Record<string, SearchFilterDefinition['kind']>> = {
  select: 'choice',
  'multi-select': 'choice',
  boolean: 'toggle',
  integer: 'range',
  decimal: 'range',
};

function pick(texts: Readonly<Record<string, string>>, locale: string): string | null {
  for (const key of [locale, ...Object.keys(texts).filter((k) => k.startsWith('en'))]) {
    const text = texts[key];
    if (typeof text === 'string' && text.trim() !== '') return text.trim();
  }
  return null;
}

/**
 * The filters of a category (pure): the codes in the order a buyer sees them, each kept only
 * while its definition is active, allowed as a filter and of a filterable type, with a name in
 * the locale (English fallback). A merged option is not offered; it is listed in `redirects`.
 * An inactive option is not offered either.
 */
export function buildCategoryFilters(input: {
  readonly codes: readonly string[];
  readonly definitions: ReadonlyMap<string, LoadedSearchDefinition>;
  readonly locale: string;
}): SearchFilterDefinition[] {
  const out: SearchFilterDefinition[] = [];
  for (const code of input.codes) {
    const definition = input.definitions.get(code);
    if (definition === undefined || definition.status !== 'active' || !definition.canBeFilter) {
      continue;
    }
    const kind = KIND_OF[definition.dataType];
    const name = pick(definition.names, input.locale);
    if (kind === undefined || name === null) continue;
    const options: SearchFilterOption[] = [];
    const redirects: Record<string, string> = {};
    if (kind === 'choice') {
      for (const optionCode of definition.optionOrder) {
        const option = definition.options.get(optionCode);
        if (option === undefined) continue;
        if (option.mergedInto !== null) {
          redirects[optionCode] = option.mergedInto;
          continue;
        }
        const label = pick(option.labels, input.locale);
        if (label === null || !option.active) continue;
        options.push({ code: optionCode, label });
      }
    }
    out.push({ code, name, kind, options, redirects });
  }
  return out;
}

/** The two global filters of the search page: the brand and the country of origin. */
export function buildGlobalFilters(input: {
  readonly brands: readonly { readonly slug: string; readonly name: string }[];
  readonly countryCodes: readonly string[];
}): SearchFilterDefinition[] {
  const brands = [...input.brands]
    .sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug))
    .slice(0, MAX_FILTER_OPTIONS)
    .map((brand) => ({ code: brand.slug, label: brand.name }));
  const countries: SearchFilterOption[] = [];
  for (const code of new Set(input.countryCodes)) {
    const label = countryName(code);
    if (label !== null) countries.push({ code, label });
  }
  countries.sort((a, b) => a.label.localeCompare(b.label));
  return [
    { code: BRAND_FACET, name: 'Brand', kind: 'choice', options: brands, redirects: {} },
    {
      code: ORIGIN_ATTRIBUTE,
      name: 'Country of origin',
      kind: 'choice',
      options: countries.slice(0, MAX_FILTER_OPTIONS),
      redirects: {},
    },
  ];
}
