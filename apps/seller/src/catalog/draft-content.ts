import { fromBase, placesOf, toBase } from './measure.ts';
import type { FormField, FormOption } from './types.ts';
import { DRAFT_KEY, SIZE_KEYS, type VariantFieldValues } from './variant-fields.ts';

// The editable parts of a working copy beside its texts: categories, tax category, attribute
// values and variants. Pure functions: they read the saved `content` into editor state and write
// the state back over it, leaving every key they do not own as it was.

/**
 * A value as a field edits it: text for most types, a flag for boolean, a list for multi-select,
 * and for a measure `{ amount, unit }` (the number typed, and the unit code picked).
 */
export type AttributeInput =
  string | boolean | readonly string[] | Readonly<Record<string, string>>;

/** The edit state of a measure field. */
export type MeasureInput = { readonly amount: string; readonly unit: string };

export const isMeasureInput = (input: AttributeInput | undefined): input is MeasureInput =>
  typeof input === 'object' &&
  input !== null &&
  !Array.isArray(input) &&
  typeof (input as Record<string, unknown>)['amount'] === 'string' &&
  typeof (input as Record<string, unknown>)['unit'] === 'string';
export type AttributeInputs = Readonly<Record<string, AttributeInput | undefined>>;

export interface VariantRow {
  /** The id the server minted, or null for a variant added in this session. */
  readonly variantId: string | null;
  /** A key the screen uses for a row that has no id yet. */
  readonly key: string;
  /** `proposed` and new variants can be removed; a published one stays. */
  readonly state: 'proposed' | 'published' | 'new';
  /** Option field code to option code. */
  readonly options: Readonly<Record<string, string>>;
  /** Locale to label. */
  readonly labels: Readonly<Record<string, string>>;
  /** V4 fields as typed: GTIN, shipping weight and box, and the gallery photos it picked. */
  readonly gtin: string;
  readonly weightGrams: string;
  readonly lengthMm: string;
  readonly widthMm: string;
  readonly heightMm: string;
  /** Ids from the product's photos; the first is the variant's main photo. */
  readonly imageIds: readonly string[];
}

/** A variant row's V4 fields before the seller fills any. */
export const NO_VARIANT_FIELDS: VariantFieldValues = {
  gtin: '',
  weightGrams: '',
  lengthMm: '',
  widthMm: '',
  heightMm: '',
  imageIds: [],
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringMap = (value: unknown): value is Record<string, string> =>
  isObject(value) && Object.values(value).every((item) => typeof item === 'string');

/** The label of a map in `locale`, else the first locale it has, else `fallback`. */
export function pickLabel(
  map: Readonly<Record<string, string>>,
  locale: string,
  fallback: string,
): string {
  return map[locale] ?? Object.values(map)[0] ?? fallback;
}

export function categoryIdsOf(content: Readonly<Record<string, unknown>> | undefined): string[] {
  const raw = content?.['categoryIds'];
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
}

/** The tag ids a draft lists, in the order entered; anything that is not a string is ignored. */
export function topicIdsOf(content: Readonly<Record<string, unknown>> | undefined): string[] {
  const raw = content?.['topicIds'];
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
}

export function taxCategoryOf(content: Readonly<Record<string, unknown>> | undefined): string {
  const raw = content?.['taxCategoryCode'];
  return typeof raw === 'string' ? raw : '';
}

/** The edit state of the attribute fields (not the variant options) from the saved values. */
export function attributeInputsOf(
  content: Readonly<Record<string, unknown>> | undefined,
  fields: readonly FormField[],
): AttributeInputs {
  const stored = content?.['attributeValues'];
  const values = isObject(stored) ? stored : {};
  const inputs: Record<string, AttributeInput> = {};
  for (const field of fields) {
    const value = values[field.code];
    if (value === undefined || value === null) continue;
    if (field.dataType === 'boolean') {
      if (typeof value === 'boolean') inputs[field.code] = value;
    } else if (field.dataType === 'multi-select') {
      if (Array.isArray(value)) {
        inputs[field.code] = value.filter((item): item is string => typeof item === 'string');
      }
    } else if (field.dataType === 'measure') {
      // Shown in the unit the seller saved it in, with no more places than the field allows.
      if (
        isObject(value) &&
        typeof value['value'] === 'string' &&
        typeof value['unit'] === 'string'
      ) {
        const shown = fromBase(value['value'], value['unit'], field.measure?.decimals ?? 0);
        inputs[field.code] = { amount: shown ?? value['value'], unit: value['unit'] };
      }
    } else if (field.localizable) {
      if (isStringMap(value)) inputs[field.code] = value;
      else if (typeof value === 'string') inputs[field.code] = { '': value };
    } else if (typeof value === 'number') inputs[field.code] = String(value);
    else if (typeof value === 'string') inputs[field.code] = value;
  }
  return inputs;
}

const WHOLE = /^-?\d+$/;
const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** `null` when the text fits the field, else the key of the problem (`whole`, `decimal`, `range`, `length`). */
export function attributeProblem(field: FormField, value: string): string | null {
  const text = value.trim();
  if (text === '') return null;
  const { min, max, maxLength } = field.bounds;
  if (field.dataType === 'integer' || field.dataType === 'decimal') {
    if (field.dataType === 'integer' ? !WHOLE.test(text) : !DECIMAL.test(text)) {
      return field.dataType === 'integer' ? 'whole' : 'decimal';
    }
    const number = Number(text);
    if (!Number.isFinite(number) || (min !== undefined && number < min)) return 'range';
    if (max !== undefined && number > max) return 'range';
  }
  if (maxLength !== undefined && [...text].length > maxLength) return 'length';
  return null;
}

/**
 * `null` when a measure input fits the field, else the key of the problem: `decimal` (not a
 * number), `places` (more decimal places than the field allows in that unit), `unit` (not one the
 * field offers) or `range` (outside min and max, which are in base units).
 */
export function measureProblem(field: FormField, input: MeasureInput | undefined): string | null {
  const amount = input?.amount.trim() ?? '';
  if (input === undefined || amount === '') return null;
  const settings = field.measure;
  if (settings === undefined || !settings.units.includes(input.unit)) return 'unit';
  const places = placesOf(amount);
  if (places === null) return 'decimal';
  if (places > settings.decimals) return 'places';
  const base = toBase(amount, input.unit);
  if (base === null) return 'decimal';
  const { min, max } = field.bounds;
  if ((min !== undefined && Number(base) < min) || (max !== undefined && Number(base) > max)) {
    return 'range';
  }
  return null;
}

function valueOf(
  field: FormField,
  input: AttributeInput | undefined,
  defaultLocale: string,
): unknown {
  if (input === undefined) return undefined;
  if (typeof input === 'boolean') return input;
  if (Array.isArray(input)) {
    const list = input as readonly string[];
    return list.length === 0 ? undefined : [...list];
  }
  if (field.dataType === 'measure') {
    if (!isMeasureInput(input)) return undefined;
    const amount = input.amount.trim();
    if (amount === '') return undefined;
    // An amount that does not convert is sent as typed, so the server names the problem.
    return { value: toBase(amount, input.unit) ?? amount, unit: input.unit };
  }
  if (typeof input === 'string') {
    const text = input.trim();
    if (text === '') return undefined;
    if (field.dataType === 'integer' && WHOLE.test(text) && Number.isSafeInteger(Number(text))) {
      return Number(text);
    }
    return text;
  }
  const map = Object.fromEntries(
    Object.entries(input as Record<string, string>)
      .map(([locale, text]) => [locale === '' ? defaultLocale : locale, text.trim()] as const)
      .filter(([, text]) => text !== ''),
  );
  return Object.keys(map).length === 0 ? undefined : map;
}

/**
 * The saved `attributeValues` with the form's fields replaced: a code the form does not show
 * (a variant option, an unknown key) is kept as it was.
 */
export function attributeValuesWith(
  content: Readonly<Record<string, unknown>> | undefined,
  fields: readonly FormField[],
  inputs: AttributeInputs,
  defaultLocale: string,
): Record<string, unknown> {
  const stored = content?.['attributeValues'];
  const next: Record<string, unknown> = isObject(stored) ? { ...stored } : {};
  for (const field of fields) {
    const value = valueOf(field, inputs[field.code], defaultLocale);
    if (value === undefined) delete next[field.code];
    else next[field.code] = value;
  }
  return next;
}

/** The rows of the variants editor: every live variant, with what the saved draft says about it. */
export function variantRowsOf(
  content: Readonly<Record<string, unknown>> | undefined,
  variants: readonly { readonly variantId: string; readonly state: string }[],
): VariantRow[] {
  const stored = content?.['variants'];
  const entries = Array.isArray(stored) ? stored.filter(isObject) : [];
  return variants
    .filter((variant) => variant.state !== 'retired')
    .map((variant) => {
      const entry = entries.find((item) => item['variantId'] === variant.variantId);
      const options = entry?.['optionValues'];
      const labels = entry?.['labels'];
      return {
        variantId: variant.variantId,
        key: variant.variantId,
        state: variant.state === 'proposed' ? 'proposed' : 'published',
        options: isStringMap(options) ? options : {},
        labels: isStringMap(labels) ? labels : {},
        ...fieldsOf(entry),
      };
    });
}

/** The V4 fields a saved draft entry holds, as editor text. */
function fieldsOf(entry: Record<string, unknown> | undefined): VariantFieldValues {
  const text = (value: unknown): string =>
    typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  const images = entry?.['imageIds'];
  return {
    gtin: text(entry?.['gtin']),
    weightGrams: text(entry?.[DRAFT_KEY.weightGrams]),
    lengthMm: text(entry?.[DRAFT_KEY.lengthMm]),
    widthMm: text(entry?.[DRAFT_KEY.widthMm]),
    heightMm: text(entry?.[DRAFT_KEY.heightMm]),
    imageIds: Array.isArray(images)
      ? images.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

/** The saved `variants` list for these rows; a new row carries its key until the server mints its id. */
export function variantsWith(rows: readonly VariantRow[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const options = Object.fromEntries(
      Object.entries(row.options).filter(([, code]) => code !== ''),
    );
    const labels = Object.fromEntries(
      Object.entries(row.labels)
        .map(([locale, label]) => [locale, label.trim()] as const)
        .filter(([, label]) => label !== ''),
    );
    const sizes = Object.fromEntries(
      SIZE_KEYS.filter((key) => row[key].trim() !== '').map(
        (key) => [DRAFT_KEY[key], Number(row[key].trim())] as const,
      ),
    );
    return {
      variantId: row.variantId ?? row.key,
      ...(Object.keys(options).length > 0 ? { optionValues: options } : {}),
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
      ...(row.gtin.trim() !== '' ? { gtin: row.gtin.trim() } : {}),
      ...sizes,
      ...(row.imageIds.length > 0 ? { imageIds: [...row.imageIds] } : {}),
    };
  });
}

/** The same rows once the server has minted ids for the new ones, in list order. */
export function withMintedIds(rows: readonly VariantRow[], ids: readonly string[]): VariantRow[] {
  return rows.map((row, index) => {
    const id = ids[index];
    return row.variantId === null && id !== undefined
      ? { ...row, variantId: id, state: 'proposed' }
      : row;
  });
}

/** A readable name for a variant row: its option labels joined, else its position. */
export function variantTitle(
  row: VariantRow,
  fields: readonly FormField[],
  locale: string,
  fallback: string,
): string {
  const parts = fields
    .filter((field) => field.isVariantOption)
    .map((field) => {
      const code = row.options[field.code];
      const option: FormOption | undefined = field.options.find((item) => item.code === code);
      return option === undefined ? null : pickLabel(option.labels, locale, option.code);
    })
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' / ') : fallback;
}

/**
 * The saved content with the classification, attribute values and variants replaced. A key the
 * draft never had stays out while its value is empty, so an untouched draft is sent back as it was.
 */
export function contentFrom(
  content: Record<string, unknown>,
  parts: {
    readonly categoryIds: readonly string[];
    /** The tag ids in the order picked; `undefined` leaves the draft's `topicIds` alone. */
    readonly topicIds?: readonly string[];
    readonly taxCategoryCode: string;
    readonly attributeValues: Record<string, unknown>;
    /** `null` for a product whose variants are fixed: its `variants` key is left alone. */
    readonly variants: Record<string, unknown>[] | null;
    /** The axis codes of a configurable product (V3); `null` leaves the draft's `variantAxes` alone. */
    readonly variantAxes?: readonly string[] | null;
  },
): Record<string, unknown> {
  const next = { ...content };
  const set = (key: string, value: unknown, empty: boolean) => {
    if (empty && !(key in next)) return;
    if (empty && (key === 'categoryIds' || key === 'attributeValues' || key === 'variants')) {
      next[key] = key === 'attributeValues' ? {} : [];
    } else if (empty) delete next[key];
    else next[key] = value;
  };
  set('categoryIds', [...parts.categoryIds], parts.categoryIds.length === 0);
  if (parts.topicIds !== undefined) {
    set('topicIds', [...parts.topicIds], parts.topicIds.length === 0);
  }
  set('taxCategoryCode', parts.taxCategoryCode, parts.taxCategoryCode === '');
  set('attributeValues', parts.attributeValues, Object.keys(parts.attributeValues).length === 0);
  if (parts.variants !== null) set('variants', parts.variants, parts.variants.length === 0);
  // Axes are written once the seller has chosen some; a draft that never had any stays without.
  if (parts.variantAxes !== undefined && parts.variantAxes !== null) {
    if (parts.variantAxes.length > 0) next['variantAxes'] = [...parts.variantAxes];
    else delete next['variantAxes'];
  }
  return next;
}
