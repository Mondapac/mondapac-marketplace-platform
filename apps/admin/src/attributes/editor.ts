// The attribute editor's form (attributes A2, part 2): the form state built from an attribute,
// the request body built from the form, the checks the panel makes before sending, and how a
// refusal of the API reads. Pure functions, tested without a browser.

import type { ApiFailure } from '../api/client.ts';
import {
  CHOICE_TYPES,
  type AttributeDetail,
  type DataType,
  type Localized,
  type MarketUnit,
} from './types.ts';

/** The longest name or value label the API keeps (domain TEXT_MAX). */
export const NAME_MAX = 120;
/** The longest help text (domain HELP_MAX). */
export const HELP_MAX = 300;
/** The longest internal note (domain NOTE_MAX). */
export const NOTE_MAX = 1000;
/** The most values one attribute has. */
export const OPTIONS_MAX = 200;
/** A code: lower-case ASCII, digits, `-` and `_`, starting with a letter. */
export const CODE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export interface ValueRow {
  /** A stable key for React; the code for a saved value, a counter for a new one. */
  readonly key: string;
  /** The saved code; empty for a new value, which gets one from its label. */
  readonly code: string;
  /** Saved before: never removed, only deactivated. */
  readonly saved: boolean;
  readonly labels: Readonly<Record<string, string>>;
  readonly active: boolean;
}

export interface EditorForm {
  readonly names: Readonly<Record<string, string>>;
  readonly helpText: Readonly<Record<string, string>>;
  readonly material: boolean;
  readonly isVariantOption: boolean;
  readonly maxLength: string;
  readonly min: string;
  readonly max: string;
  /** A measure's unit settings (attributes A3); `min` and `max` are then in the base unit. */
  readonly measureDimension: string;
  readonly measureUnits: readonly string[];
  readonly measureDefaultUnit: string;
  readonly measureDecimals: string;
  readonly values: readonly ValueRow[];
  readonly showOnProductPage: boolean;
  readonly searchable: boolean;
  readonly canBeFilter: boolean;
  readonly internalNote: string;
  readonly position: string;
}

/** The dimensions a measure can have, and each one's base unit (the stored unit). */
export const MEASURE_DIMENSIONS = ['mass', 'volume', 'length', 'count'] as const;
export const BASE_UNIT: Readonly<Record<string, string>> = {
  mass: 'g',
  volume: 'ml',
  length: 'mm',
  count: 'count',
};
/** The most decimal places an administrator may allow. */
export const DECIMALS_MAX = 6;

/** The Market's units of one dimension, in the Market's order. */
export function unitsOf(units: readonly MarketUnit[], dimension: string): readonly MarketUnit[] {
  return units.filter((unit) => unit.dimension === dimension);
}

/** The unit settings a measure starts with: every unit of the dimension, the base unit as default. */
export function measureDefaults(
  units: readonly MarketUnit[],
  dimension: string,
): Pick<EditorForm, 'measureDimension' | 'measureUnits' | 'measureDefaultUnit'> {
  const offered = unitsOf(units, dimension).map((unit) => unit.code);
  const base = BASE_UNIT[dimension] ?? '';
  return {
    measureDimension: dimension,
    measureUnits: offered,
    measureDefaultUnit: offered.includes(base) ? base : (offered[0] ?? ''),
  };
}

const numberText = (value: number | undefined): string =>
  value === undefined ? '' : String(value);

/** The form of a saved attribute. */
export function formOf(detail: AttributeDetail): EditorForm {
  return {
    names: { ...detail.names },
    helpText: { ...detail.display.helpText },
    material: detail.material,
    isVariantOption: detail.isVariantOption,
    maxLength: numberText(detail.bounds.maxLength),
    min: numberText(detail.bounds.min),
    max: numberText(detail.bounds.max),
    measureDimension: detail.bounds.measure?.dimension ?? 'mass',
    measureUnits: detail.bounds.measure?.units ?? [],
    measureDefaultUnit: detail.bounds.measure?.defaultUnit ?? '',
    measureDecimals: numberText(detail.bounds.measure?.decimals ?? 0),
    values: [...detail.options]
      .sort((a, b) => a.position - b.position)
      .map((option) => ({
        key: option.code,
        code: option.code,
        saved: true,
        labels: { ...option.labels },
        active: option.active,
      })),
    showOnProductPage: detail.display.showOnProductPage,
    searchable: detail.display.searchable,
    canBeFilter: detail.display.canBeFilter,
    internalNote: detail.display.internalNote ?? '',
    position: String(detail.display.position),
  };
}

/** A new attribute's form: shown on the product page, nothing else switched on. */
export function emptyForm(): EditorForm {
  return {
    names: {},
    helpText: {},
    material: false,
    isVariantOption: false,
    maxLength: '',
    min: '',
    max: '',
    measureDimension: 'mass',
    measureUnits: [],
    measureDefaultUnit: '',
    measureDecimals: '0',
    values: [],
    showOnProductPage: true,
    searchable: false,
    canBeFilter: false,
    internalNote: '',
    position: '0',
  };
}

let nextKey = 0;
/** A new, empty value row. */
export function newValue(): ValueRow {
  nextKey += 1;
  return { key: `new-${nextKey}`, code: '', saved: false, labels: {}, active: true };
}

/** Values from text with one value per line (the Add dialog); blank lines are left out. */
export function valuesFromLines(text: string, locale: string): ValueRow[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((label) => ({ ...newValue(), labels: { [locale]: label } }));
}

/**
 * The code the API derives from a text (same rule as the API's `codeFrom`): lower-case ASCII
 * letters and digits joined by `-`, `v-` before a leading digit; empty when nothing is left (a
 * text in another script, where the admin types the code).
 */
export function suggestCode(text: string): string {
  const ascii = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
    .replace(/-+$/, '');
  if (ascii === '') return '';
  return /^[a-z]/.test(ascii) ? ascii : `v-${ascii}`;
}

/** The entries with text, trimmed: an empty entry is a language not entered yet. */
function filled(map: Readonly<Record<string, string>>): Localized {
  const out: Record<string, string> = {};
  for (const [locale, text] of Object.entries(map)) {
    const trimmed = text.trim();
    if (trimmed !== '') out[locale] = trimmed;
  }
  return out;
}

const NUMERIC: ReadonlySet<string> = new Set(['integer', 'decimal', 'measure']);
const TEXTUAL: ReadonlySet<string> = new Set(['text', 'long-text']);

function boundsOf(form: EditorForm, dataType: DataType) {
  const out: {
    maxLength?: number;
    min?: number;
    max?: number;
    measure?: { dimension: string; units: string[]; defaultUnit: string; decimals: number };
  } = {};
  if (TEXTUAL.has(dataType) && form.maxLength.trim() !== '') {
    out.maxLength = Number(form.maxLength);
  }
  if (NUMERIC.has(dataType)) {
    if (form.min.trim() !== '') out.min = Number(form.min);
    if (form.max.trim() !== '') out.max = Number(form.max);
  }
  if (dataType === 'measure') {
    out.measure = {
      dimension: form.measureDimension,
      units: [...form.measureUnits],
      defaultUnit: form.measureDefaultUnit,
      decimals: Number(form.measureDecimals),
    };
  }
  return out;
}

/**
 * The whole content the API takes on create and on edit: every key is sent, because an edit
 * replaces the content (a key left out would be read as its default).
 */
export function contentOf(form: EditorForm, dataType: DataType, defaultLocale: string) {
  const note = form.internalNote.trim();
  return {
    names: filled(form.names),
    material: form.material,
    isVariantOption: dataType === 'select' ? form.isVariantOption : false,
    bounds: boundsOf(form, dataType),
    options: CHOICE_TYPES.has(dataType) ? optionsOf(form.values, defaultLocale) : [],
    helpText: filled(form.helpText),
    showOnProductPage: form.showOnProductPage,
    searchable: form.searchable,
    canBeFilter: form.canBeFilter,
    internalNote: note === '' ? null : note,
    position: form.position.trim() === '' ? 0 : Number(form.position),
  };
}

/**
 * The values as the API takes them. A new value whose label gives no code (a label in another
 * script, such as 小) and that has none typed gets `value-N`, the first number free: codes are
 * the admin's identifiers and never shown to sellers or buyers.
 */
function optionsOf(values: readonly ValueRow[], defaultLocale: string) {
  const taken = new Set<string>();
  for (const value of values) {
    const code = value.code.trim() || suggestCode(value.labels[defaultLocale] ?? '');
    if (code !== '') taken.add(code);
  }
  let next = 1;
  return values.map((value) => {
    let code = value.code.trim();
    if (code === '' && suggestCode(value.labels[defaultLocale] ?? '') === '') {
      while (taken.has(`value-${next}`)) next += 1;
      code = `value-${next}`;
      taken.add(code);
    }
    return {
      ...(code === '' ? {} : { code }),
      labels: filled(value.labels),
      active: value.active,
    };
  });
}

/**
 * The code each value is saved under, by row: its own or `value-N` code, else the API's rule
 * (attribute-editor `freeCode`): the code from the default-language label, made unique with
 * `-2`, `-3`... against the codes before it and every code given. A refusal that names a value by
 * code is pointed at its row through this list.
 */
export function sentCodes(values: readonly ValueRow[], defaultLocale: string): string[] {
  const options = optionsOf(values, defaultLocale);
  const given = new Set(
    options.flatMap((option) => (option.code === undefined ? [] : [option.code])),
  );
  const taken = new Set<string>();
  return options.map((option, index) => {
    let code = option.code;
    if (code === undefined) {
      const base = suggestCode(values[index]?.labels[defaultLocale] ?? '');
      const used = (candidate: string) => taken.has(candidate) || given.has(candidate);
      code = base;
      for (let n = 2; base !== '' && used(code) && n <= OPTIONS_MAX + 1; n += 1)
        code = `${base}-${n}`;
    }
    taken.add(code);
    return code;
  });
}

/** Field errors by path (`names.en-AU`, `options[2].labels.fa-IR`, `code`, ...), a reason each. */
export type FieldErrors = Readonly<Record<string, string>>;

const DECIMAL = /^-?\d+(\.\d+)?$/;
const WHOLE = /^\d+$/;

/** The panel's own checks before a save: the default-language name, labels, numbers. */
export function checkForm(
  form: EditorForm,
  dataType: DataType,
  defaultLocale: string,
): FieldErrors {
  const errors: Record<string, string> = {};
  if ((form.names[defaultLocale] ?? '').trim() === '') {
    errors[`names.${defaultLocale}`] = 'required';
  }
  if (CHOICE_TYPES.has(dataType)) {
    form.values.forEach((value, index) => {
      if ((value.labels[defaultLocale] ?? '').trim() === '') {
        errors[`options[${index}].labels.${defaultLocale}`] = 'required';
      }
      const code = value.code.trim();
      if (!value.saved && code !== '' && !CODE_PATTERN.test(code)) {
        errors[`options[${index}].code`] = 'format';
      }
    });
  }
  if (TEXTUAL.has(dataType) && form.maxLength.trim() !== '' && !WHOLE.test(form.maxLength.trim())) {
    errors['bounds.maxLength'] = 'number';
  }
  if (dataType === 'measure') {
    if (form.measureUnits.length === 0) errors['bounds.measure.units'] = 'required';
    else if (!form.measureUnits.includes(form.measureDefaultUnit)) {
      errors['bounds.measure.defaultUnit'] = 'required';
    }
    const places = form.measureDecimals.trim();
    if (!WHOLE.test(places) || Number(places) > DECIMALS_MAX) {
      errors['bounds.measure.decimals'] = 'number';
    }
  }
  if (NUMERIC.has(dataType)) {
    const pattern =
      dataType === 'integer' ? /^-?\d+$/ : dataType === 'measure' ? /^\d+(\.\d+)?$/ : DECIMAL;
    for (const key of ['min', 'max'] as const) {
      const text = form[key].trim();
      if (text !== '' && (!pattern.test(text) || !Number.isFinite(Number(text)))) {
        errors[`bounds.${key}`] = 'number';
      }
    }
    const [min, max] = [form.min.trim(), form.max.trim()];
    if (
      errors['bounds.min'] === undefined &&
      errors['bounds.max'] === undefined &&
      min !== '' &&
      max !== '' &&
      Number(min) > Number(max)
    ) {
      errors['bounds.max'] = 'below-min';
    }
  }
  const position = form.position.trim();
  if (position !== '' && (!WHOLE.test(position) || Number(position) > 32_767)) {
    errors['position'] = 'number';
  }
  return errors;
}

/** The languages with a missing name or a missing label of an active value. */
export function missingLocales(
  form: EditorForm,
  dataType: DataType,
  supported: readonly string[],
): readonly string[] {
  return supported.filter((locale) => {
    if ((form.names[locale] ?? '').trim() === '') return true;
    if (!CHOICE_TYPES.has(dataType)) return false;
    return form.values.some((value) => value.active && (value.labels[locale] ?? '').trim() === '');
  });
}

/** What the panel shows for a refused write. */
export interface EditorProblem {
  /** Message key under `attributes.editor.error`. */
  readonly key: string;
  /** The attribute changed, vanished or is no longer a draft: read it again. */
  readonly reload: boolean;
  readonly fields: FieldErrors;
}

const BY_CODE: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'attribute.stale': 'stale',
  'attribute.not-found': 'gone',
  'attribute.code-taken': 'code-taken',
  'attribute.claim-word': 'claim-word',
  'attribute.locale-uncheckable': 'locale-uncheckable',
  'claim-text.check-unavailable': 'check-unavailable',
  'attribute-definition.not-draft': 'not-draft',
  'attribute-definition.archived': 'archived',
  'attribute-definition.option-removed': 'option-removed',
  'attribute-definition.variant-locked': 'variant-locked',
  'attribute-definition.measure-invalid': 'measure-invalid',
  'attribute-definition.measure-locked': 'measure-locked',
  'attribute-definition.material-relaxation-required': 'material-relaxation',
  'attribute-definition.default-name-required': 'default-name-required',
  'attribute-definition.default-label-required': 'default-label-required',
  'attribute-definition.active-option-required': 'active-option-required',
  'access.denied': 'denied',
  'request.csrf': 'csrf',
  'request.throttled': 'throttled',
  'request.too-large': 'too-large',
  // The two-person request to turn off Material (attributes A2 part 3).
  'attribute-definition.not-material': 'not-material',
  'relaxation.already-open': 'relaxation-already-open',
  'relaxation.not-found': 'relaxation-gone',
  'relaxation.stale': 'relaxation-moved',
  'relaxation.closed': 'relaxation-moved',
  'relaxation.expired': 'relaxation-expired',
  'relaxation.attribute-changed': 'relaxation-attribute-changed',
  'relaxation.same-admin': 'relaxation-same-admin',
  'relaxation.not-requester': 'relaxation-not-requester',
  // Merging values and archiving (attributes A8).
  'attribute-definition.merge-invalid': 'merge-invalid',
  'attribute-definition.not-select': 'not-select',
  'attribute-definition.merge-type-mismatch': 'merge-type-mismatch',
  'attribute-definition.merge-unmapped': 'merge-unmapped',
  'attribute-definition.merge-material': 'merge-material',
  'attribute-definition.not-published': 'not-published',
  'attribute.archive-needs-second-admin': 'archive-needs-second-admin',
  'attribute.archive-not-material': 'archive-not-material',
};

const RELOAD: ReadonlySet<string> = new Set([
  'stale',
  'gone',
  'not-draft',
  'archived',
  'not-material',
  'relaxation-gone',
  'relaxation-moved',
  'relaxation-expired',
  'relaxation-attribute-changed',
  'not-published',
  'archive-needs-second-admin',
  'archive-not-material',
]);

/**
 * A refusal as the panel shows it. A value the API names by its code (`options.<code>...`) is
 * pointed at by its row (`options[<index>]...`), as the panel's own checks are.
 */
export function problemOf(failure: ApiFailure, codes: readonly string[] = []): EditorProblem {
  let key = BY_CODE[failure.code];
  if (failure.code === 'attribute.archive-blocked') {
    // The API names why in `details.fields[0].code`: an active feature set, or live variants.
    key =
      failure.details?.fields?.[0]?.code === 'live-variants'
        ? 'archive-blocked-live-variants'
        : failure.details?.fields?.[0]?.code === 'merge-target'
          ? 'blocked-merge-target'
          : 'archive-blocked-in-feature-set';
  }
  if (failure.code === 'attribute.merge-blocked') {
    key =
      failure.details?.fields?.[0]?.code === 'live-variants'
        ? 'merge-blocked-live-variants'
        : failure.details?.fields?.[0]?.code === 'merge-target'
          ? 'blocked-merge-target'
          : 'merge-blocked-in-feature-set';
  }
  if (key === undefined) {
    if (failure.status === 0 || failure.status >= 500) key = 'unavailable';
    else if (failure.code.startsWith('attribute-definition.')) key = 'content';
    else key = 'unknown';
  }
  const fields: Record<string, string> = {};
  for (const field of failure.details?.fields ?? []) {
    fields[rowPath(field.path, codes)] = field.code;
  }
  if (failure.code === 'attribute.code-taken') fields['code'] = 'taken';
  return { key, reload: RELOAD.has(key), fields };
}

const BY_CODE_PATH = /^options\.([a-z][a-z0-9_-]{0,63})(\..*)?$/;

function rowPath(path: string, codes: readonly string[]): string {
  const match = BY_CODE_PATH.exec(path);
  if (match === null) return path;
  const index = codes.indexOf(match[1] ?? '');
  return index < 0 ? path : `options[${index}]${match[2] ?? ''}`;
}

/** A field reason as a message key under `attributes.editor.field`. */
export function fieldKey(reason: string): string {
  switch (reason) {
    case 'required':
    case 'claim-word':
    case 'locale-uncheckable':
    case 'too-long':
    case 'invalid':
    case 'format':
    case 'repeated':
    case 'taken':
    case 'removed':
    case 'number':
    case 'below-min':
    case 'unavailable':
    case 'not-offered':
      return reason;
    default:
      return 'other';
  }
}

/** The values moved: the row at `from` goes to `to`. */
export function moved<T>(rows: readonly T[], from: number, to: number): T[] {
  const next = [...rows];
  if (to < 0 || to >= next.length) return next;
  const [row] = next.splice(from, 1);
  if (row !== undefined) next.splice(to, 0, row);
  return next;
}

/**
 * The field errors after the values moved: `order[i]` is the old index of the row now at `i`; an
 * error of a row that is gone is dropped.
 */
export function remapValueErrors(errors: FieldErrors, order: readonly number[]): FieldErrors {
  const out: Record<string, string> = {};
  for (const [path, reason] of Object.entries(errors)) {
    const match = /^options\[(\d+)\](.*)$/.exec(path);
    if (match === null) {
      out[path] = reason;
      continue;
    }
    const at = order.indexOf(Number(match[1]));
    if (at >= 0) out[`options[${at}]${match[2] ?? ''}`] = reason;
  }
  return out;
}
