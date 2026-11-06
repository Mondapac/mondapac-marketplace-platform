import type { AttributeDataType } from '@mondapac/shared-kernel';
import { countryCodeOf, countryName } from './iso-countries';
import { mergedValue } from './published-specifications';

/** The attribute codes the index treats specially: the brand (a product column) and the origin. */
export const BRAND_FACET = 'brand';
export const ORIGIN_ATTRIBUTE = 'country-of-origin';

/** Limits of what one document carries (the column CHECKs in search say the same). */
export const MAX_FACET_CODES = 100;
export const MAX_SEARCH_TEXT = 2000;
export const MAX_SEARCH_TEXT_VALUE = 200;
const MAX_MERGE_HOPS = 5;
const NUMBER = /^-?[0-9]{1,15}(\.[0-9]{1,9})?$/;

export interface SearchOption {
  readonly labels: Readonly<Record<string, string>>;
  /** The option this one was merged into (attributes A8); followed at read time. */
  readonly mergedInto: string | null;
  /** An inactive option is no longer offered to sellers or as a filter; products keep it. */
  readonly active: boolean;
}

/** What the index needs of one attribute definition's published revision. */
export interface SearchDefinition {
  readonly dataType: AttributeDataType;
  readonly localizable: boolean;
  readonly status: 'draft' | 'active' | 'archived';
  /** Its values are searched as text. */
  readonly searchable: boolean;
  /** May be offered as a category filter: its values are indexed as facets. */
  readonly canBeFilter: boolean;
  readonly options: ReadonlyMap<string, SearchOption>;
  /**
   * The attribute this one was merged into (attributes A8): its code, and for a choice attribute
   * where each of its option codes goes. A product's value is indexed as the target's.
   */
  readonly mergedInto?: {
    readonly code: string;
    readonly options: ReadonlyMap<string, string>;
  } | null;
}

/** A definition's PUBLISHED revision as search reads it, with the names a filter list shows. */
export interface LoadedSearchDefinition extends SearchDefinition {
  readonly code: string;
  readonly names: Readonly<Record<string, string>>;
  /** Option codes in the definition's order. */
  readonly optionOrder: readonly string[];
}

/** What a product brings to the index of its Offers: the active brand, by address and spellings. */
export interface SearchBrand {
  readonly slug: string;
  readonly name: string;
  readonly aliases: readonly string[];
}

/**
 * What the index keeps of a product's attributes (attributes A7). `facets` are `attribute=value`
 * strings: an option code (merged options already followed to their target), `true` for a yes,
 * `brand=<slug>`, `country-of-origin=<iso code>`. `numbers` are the values a range filter reads.
 * `searchText` is words only, weighed below the name and short text.
 */
export interface SearchAttributeFacts {
  readonly searchText: string;
  readonly facets: readonly string[];
  readonly numbers: Readonly<Record<string, number>>;
}

export const NO_SEARCH_ATTRIBUTES: SearchAttributeFacts = {
  searchText: '',
  facets: [],
  numbers: {},
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The label for the locale, else any English one; never another language's text. */
function labelOf(labels: Readonly<Record<string, string>>, locale: string): string | null {
  const exact = labels[locale];
  if (typeof exact === 'string' && exact.trim() !== '') return exact.trim();
  for (const [key, text] of Object.entries(labels)) {
    if (key.startsWith('en') && typeof text === 'string' && text.trim() !== '') return text.trim();
  }
  return null;
}

/** The option a code stands for after following merges, or null when it cannot be told. */
export function resolveOption(
  definition: Pick<SearchDefinition, 'options'>,
  code: unknown,
): { readonly code: string; readonly option: SearchOption } | null {
  if (typeof code !== 'string') return null;
  let current = code;
  let option = definition.options.get(current);
  for (let hop = 0; option?.mergedInto != null && hop < MAX_MERGE_HOPS; hop += 1) {
    current = option.mergedInto;
    option = definition.options.get(current);
  }
  return option === undefined ? null : { code: current, option };
}

function plain(stored: unknown, definition: SearchDefinition, locale: string): unknown {
  if (!definition.localizable) return stored;
  if (!isRecord(stored)) return null;
  const entry = stored[locale];
  return entry === undefined || entry === '' ? null : entry;
}

/**
 * Builds the index facts of one product (pure). A draft definition contributes nothing; a value
 * the definition cannot read (an option it no longer lists, a wrong type) is left out, never
 * indexed raw. The brand and the country of origin are always searchable and always facets: they
 * are the platform's global filters.
 */
export function buildSearchAttributes(input: {
  readonly values: Readonly<Record<string, unknown>>;
  readonly definitions: ReadonlyMap<string, SearchDefinition>;
  readonly brand: SearchBrand | null;
  readonly locale: string;
}): SearchAttributeFacts {
  const facets = new Set<string>();
  const words: string[] = [];
  const numbers: Record<string, number> = {};
  if (input.brand !== null) {
    facets.add(`${BRAND_FACET}=${input.brand.slug}`);
    words.push(input.brand.name, ...input.brand.aliases);
  }
  for (const [code, stored] of Object.entries(input.values)) {
    if (code === BRAND_FACET || stored === undefined || stored === null) continue;
    const own = input.definitions.get(code);
    if (own === undefined) continue;
    let definition: SearchDefinition = own;
    let value: unknown = stored;
    let at = code;
    // A merged attribute is indexed as its target (attributes A8): the value is mapped, and the
    // target's own value wins when the product has both. A target that is not active adds nothing.
    if (own.mergedInto != null) {
      const target = input.definitions.get(own.mergedInto.code);
      const targetValue = input.values[own.mergedInto.code];
      if (target === undefined || target.status !== 'active') continue;
      if (targetValue !== undefined && targetValue !== null) continue;
      const mapped = mergedValue(own.mergedInto.options, stored);
      if (mapped === null) continue;
      definition = target;
      value = mapped;
      at = own.mergedInto.code;
    } else if (own.status !== 'active') {
      continue;
    }
    const raw = plain(value, definition, input.locale);
    if (raw === null || raw === undefined) continue;
    if (at === ORIGIN_ATTRIBUTE) {
      const countries = Array.isArray(raw) ? raw : [raw];
      for (const entry of countries as unknown[]) {
        if (typeof entry !== 'string') continue;
        const country = countryCodeOf(entry);
        if (country === null) continue;
        facets.add(`${ORIGIN_ATTRIBUTE}=${country}`);
        const name = countryName(country);
        if (name !== null) words.push(name);
      }
      continue;
    }
    switch (definition.dataType) {
      case 'select':
      case 'multi-select': {
        const picked = definition.dataType === 'select' ? [raw] : Array.isArray(raw) ? raw : [];
        for (const entry of picked as unknown[]) {
          const resolved = resolveOption(definition, entry);
          if (resolved === null) continue;
          if (definition.canBeFilter) facets.add(`${at}=${resolved.code}`);
          if (definition.searchable) {
            const label = labelOf(resolved.option.labels, input.locale);
            if (label !== null) words.push(label);
          }
        }
        break;
      }
      case 'boolean':
        if (raw === true && definition.canBeFilter) facets.add(`${at}=true`);
        break;
      case 'integer':
      case 'decimal': {
        if (!definition.canBeFilter) break;
        const text = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw;
        if (typeof text === 'string' && NUMBER.test(text)) numbers[at] = Number(text);
        break;
      }
      case 'text':
        if (definition.searchable && typeof raw === 'string' && raw.trim() !== '') {
          words.push([...raw.trim()].slice(0, MAX_SEARCH_TEXT_VALUE).join(''));
        }
        break;
      default:
        break;
    }
  }
  const searchText = [
    ...new Set(words.map((word) => word.trim()).filter((word) => word !== '')),
  ].join(' ');
  return {
    searchText: [...searchText].slice(0, MAX_SEARCH_TEXT).join(''),
    facets: [...facets].sort().slice(0, MAX_FACET_CODES),
    numbers,
  };
}
