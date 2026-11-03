import type { AttributeDataType } from '@mondapac/shared-kernel';
import type { FamilyGroup } from './attribute-family';

/** The most specification rows a product page lists, and the most values one list row carries. */
export const MAX_PUBLISHED_SPECIFICATIONS = 60;
export const MAX_SPECIFICATION_VALUES = 20;

/** One value of a row, typed so the page formats it (the facade's `PublishedSpecificationValue`). */
export type PublishedSpecificationValue =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'list'; readonly items: readonly string[] }
  | { readonly kind: 'number'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'date'; readonly value: string };

export interface PublishedSpecification {
  readonly code: string;
  readonly name: string;
  readonly value: PublishedSpecificationValue;
}

export interface PublishedSpecificationGroup {
  readonly groupCode: string;
  readonly specifications: readonly PublishedSpecification[];
}

/** What the product page needs of one option of a select definition. */
export interface SpecificationOption {
  readonly labels: Readonly<Record<string, string>>;
  /** The option this one was merged into (attributes A8); read-time mapping. */
  readonly mergedInto: string | null;
}

/** What the product page needs of one attribute definition's published revision. */
export interface SpecificationDefinition {
  readonly dataType: AttributeDataType;
  readonly localizable: boolean;
  readonly status: 'draft' | 'active' | 'archived';
  readonly showOnProductPage: boolean;
  readonly names: Readonly<Record<string, string>>;
  readonly options: ReadonlyMap<string, SpecificationOption>;
}

export interface SpecificationLocales {
  readonly requested: string;
  readonly fallback: string;
}

/** Attributes shown elsewhere on the page: the brand link, and (below) long text as description. */
const SHOWN_ELSEWHERE = new Set(['brand']);
const NUMBER = /^-?[0-9]{1,15}(\.[0-9]{1,9})?$/;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const MAX_MERGE_HOPS = 5;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The text for the locale: asked, else the fallback; never another locale's text. */
function pickText(
  texts: Readonly<Record<string, unknown>>,
  locales: SpecificationLocales,
): string | null {
  for (const locale of [locales.requested, locales.fallback]) {
    const text = texts[locale];
    if (typeof text === 'string' && text.trim() !== '') return text;
  }
  return null;
}

/** The option's label, following a merge to its target; null when it cannot be told. */
function optionLabel(
  definition: SpecificationDefinition,
  code: unknown,
  locales: SpecificationLocales,
): string | null {
  if (typeof code !== 'string') return null;
  let option = definition.options.get(code);
  for (let hop = 0; option?.mergedInto != null && hop < MAX_MERGE_HOPS; hop += 1) {
    option = definition.options.get(option.mergedInto);
  }
  return option === undefined ? null : pickText(option.labels, locales);
}

function valueOf(
  definition: SpecificationDefinition,
  stored: unknown,
  locales: SpecificationLocales,
): PublishedSpecificationValue | null {
  let raw = stored;
  if (definition.localizable) {
    // A localizable value is one entry per locale, picked like a text; another locale's value is
    // never shown in place of a missing one.
    if (!isRecord(raw)) return null;
    const entries = raw;
    const hit = [locales.requested, locales.fallback]
      .map((locale) => entries[locale])
      .find((entry) => entry !== undefined && entry !== null && entry !== '');
    if (hit === undefined) return null;
    raw = hit;
  }
  switch (definition.dataType) {
    case 'text':
      return typeof raw === 'string' && raw.trim() !== ''
        ? { kind: 'text', text: raw.trim() }
        : null;
    case 'integer':
    case 'decimal': {
      const text = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw;
      return typeof text === 'string' && NUMBER.test(text) ? { kind: 'number', value: text } : null;
    }
    case 'boolean':
      return typeof raw === 'boolean' ? { kind: 'boolean', value: raw } : null;
    case 'date':
      return typeof raw === 'string' && ISO_DATE.test(raw) ? { kind: 'date', value: raw } : null;
    case 'select': {
      const label = optionLabel(definition, raw, locales);
      return label === null ? null : { kind: 'text', text: label };
    }
    case 'multi-select': {
      if (!Array.isArray(raw)) return null;
      const items = new Set<string>();
      for (const code of raw as unknown[]) {
        const label = optionLabel(definition, code, locales);
        if (label !== null) items.add(label);
        if (items.size === MAX_SPECIFICATION_VALUES) break;
      }
      return items.size === 0 ? null : { kind: 'list', items: [...items] };
    }
    // Long text is the description; any type the page does not know is not shown.
    default:
      return null;
  }
}

/**
 * The specifications of a published revision for the product page (attributes A6): the revision's
 * family groups in order, and in each group the attributes in order whose definition is not a
 * draft and is shown on the product page, that are not variant options, and that have a value the
 * page can show. A value that cannot be turned into text (an option code the definition no longer
 * lists, a wrong type) is left out, never shown raw. At most {@link MAX_PUBLISHED_SPECIFICATIONS}
 * rows. A group with no row is left out.
 */
export function buildPublishedSpecifications(input: {
  readonly groups: readonly FamilyGroup[];
  readonly values: Readonly<Record<string, unknown>>;
  readonly definitions: ReadonlyMap<string, SpecificationDefinition>;
  readonly locales: SpecificationLocales;
}): PublishedSpecificationGroup[] {
  const out: PublishedSpecificationGroup[] = [];
  let rows = 0;
  for (const group of input.groups) {
    const specifications: PublishedSpecification[] = [];
    for (const entry of group.attributes) {
      if (rows >= MAX_PUBLISHED_SPECIFICATIONS) break;
      if (entry.isVariantOption || SHOWN_ELSEWHERE.has(entry.code)) continue;
      const definition = input.definitions.get(entry.code);
      if (definition === undefined || definition.status === 'draft') continue;
      if (!definition.showOnProductPage || definition.dataType === 'long-text') continue;
      const stored = input.values[entry.code];
      if (stored === undefined || stored === null) continue;
      const name = pickText(definition.names, input.locales);
      const value = valueOf(definition, stored, input.locales);
      if (name === null || value === null) continue;
      specifications.push({ code: entry.code, name, value });
      rows += 1;
    }
    if (specifications.length > 0) out.push({ groupCode: group.groupCode, specifications });
  }
  return out;
}
