import { isMeasureValue, measureFromBase } from '@mondapac/shared-kernel';
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
  | { readonly kind: 'date'; readonly value: string }
  | { readonly kind: 'measure'; readonly value: string; readonly unitLabel: string };

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
  /**
   * The attribute this one was merged into (attributes A8): its code, and for a choice attribute
   * where each of its option codes goes. Read-time mapping; the product revision is not changed.
   */
  readonly mergedInto?: {
    readonly code: string;
    readonly options: ReadonlyMap<string, string>;
  } | null;
  /** A `measure` only: the decimal places the published revision allows (attributes A3). */
  readonly measureDecimals?: number;
}

/** The Market's labels of its measure units ("kg", "kilogram"), by unit code. */
export type SpecificationUnitLabels = ReadonlyMap<string, Readonly<Record<string, string>>>;

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
  unitLabels: SpecificationUnitLabels,
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
      // A value stored before a select was converted is one code (attributes A8).
      const list: unknown = typeof raw === 'string' ? [raw] : raw;
      if (!Array.isArray(list)) return null;
      const items = new Set<string>();
      for (const code of list as unknown[]) {
        const label = optionLabel(definition, code, locales);
        if (label !== null) items.add(label);
        if (items.size === MAX_SPECIFICATION_VALUES) break;
      }
      return items.size === 0 ? null : { kind: 'list', items: [...items] };
    }
    case 'measure': {
      // Stored in the base unit with the seller's unit; shown in that unit, never another.
      if (!isMeasureValue(raw) || definition.measureDecimals === undefined) return null;
      const value = measureFromBase(raw.value, raw.unit, definition.measureDecimals);
      const labels = unitLabels.get(raw.unit);
      const unitLabel = labels === undefined ? null : pickText(labels, locales);
      return value === null || unitLabel === null ? null : { kind: 'measure', value, unitLabel };
    }
    // Long text is the description; any type the page does not know is not shown.
    default:
      return null;
  }
}

/**
 * A stored value of a merged attribute as the target holds it: an option code goes through the
 * map (a code the map lacks cannot be told, so null), a list maps each code; any other value is
 * the same value, as the types are equal.
 */
export function mergedValue(options: ReadonlyMap<string, string>, stored: unknown): unknown {
  if (options.size === 0) return stored;
  if (typeof stored === 'string') return options.get(stored) ?? null;
  if (Array.isArray(stored)) {
    const mapped = (stored as unknown[]).flatMap((code) => {
      const goes = typeof code === 'string' ? options.get(code) : undefined;
      return goes === undefined ? [] : [goes];
    });
    return mapped.length === 0 ? null : [...new Set(mapped)];
  }
  return null;
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
  /** The Market's unit labels; a measure whose unit has no label in the locale is left out. */
  readonly unitLabels: SpecificationUnitLabels;
}): PublishedSpecificationGroup[] {
  const out: PublishedSpecificationGroup[] = [];
  let rows = 0;
  for (const group of input.groups) {
    const specifications: PublishedSpecification[] = [];
    for (const entry of group.attributes) {
      if (rows >= MAX_PUBLISHED_SPECIFICATIONS) break;
      if (entry.isVariantOption || SHOWN_ELSEWHERE.has(entry.code)) continue;
      const own = input.definitions.get(entry.code);
      if (own === undefined || own.status === 'draft') continue;
      let definition = own;
      let code = entry.code;
      let stored = input.values[entry.code];
      if (stored === undefined || stored === null) continue;
      // A merged attribute reads as its target (attributes A8): the value is mapped, the row shows
      // the target's name and labels. The target's own value wins when the product has both.
      if (own.mergedInto !== undefined && own.mergedInto !== null) {
        const target = input.definitions.get(own.mergedInto.code);
        if (target === undefined || target.status !== 'active') continue;
        const targetValue = input.values[own.mergedInto.code];
        if (targetValue !== undefined && targetValue !== null) continue;
        const mapped = mergedValue(own.mergedInto.options, stored);
        if (mapped === null) continue;
        definition = target;
        code = own.mergedInto.code;
        stored = mapped;
      }
      if (!definition.showOnProductPage || definition.dataType === 'long-text') continue;
      const name = pickText(definition.names, input.locales);
      const value = valueOf(definition, stored, input.locales, input.unitLabels);
      if (name === null || value === null) continue;
      specifications.push({ code, name, value });
      rows += 1;
    }
    if (specifications.length > 0) out.push({ groupCode: group.groupCode, specifications });
  }
  return out;
}
