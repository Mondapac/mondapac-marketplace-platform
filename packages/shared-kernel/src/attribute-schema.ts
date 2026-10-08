import { err, ok } from './result';
import type { Result } from './result';
import type { Id } from './id';
import { parsePlainText } from './plain-text';

/** A BCP 47 tag of a Market locale, e.g. the Market's default locale. */
export type Locale = string;

export const ATTRIBUTE_DATA_TYPES = [
  'text',
  'long-text',
  'integer',
  'decimal',
  'boolean',
  'select',
  'multi-select',
  'date',
] as const;
export type AttributeDataType = (typeof ATTRIBUTE_DATA_TYPES)[number];

/** One option of a select field. The label per locale lives with the definition, not here. */
export interface OptionRef {
  readonly code: string;
}

/**
 * One field of a family as a revision saw it (catalog design 3.3). There is no `image` type at
 * launch and no monetary field: money is `pricing`'s.
 */
export interface AttributeField {
  readonly code: string;
  readonly dataType: AttributeDataType;
  /** A value per locale of the Market; there is no per-channel value. */
  readonly localizable: boolean;
  /** From the family group. For a localizable field, required in the default locale only. */
  readonly required: boolean;
  /** A select used to define variants of a configurable product. */
  readonly isVariantOption: boolean;
  /** ADR-0012 decision 3: a change to it is a material content change. */
  readonly material: boolean;
  /** Every text value and option label reaches the claim-text check (default-deny). */
  readonly claimChecked: true;
  readonly bounds: {
    readonly maxLength?: number;
    readonly min?: number;
    readonly max?: number;
    readonly options?: readonly OptionRef[];
  };
}

/** The revisions a schema was built from, recorded on every product revision it validates. */
export interface AttributeSchemaRef {
  readonly familyCode: string;
  readonly familyRevisionId: Id;
  readonly definitionRevisionIds: readonly Id[];
}

export interface AttributeSchema {
  readonly schemaRef: AttributeSchemaRef;
  readonly fields: readonly AttributeField[];
}

/**
 * Values by field code. A value is a string (text, long-text, decimal as text, select option
 * code, date as `YYYY-MM-DD`), a safe integer, a boolean, a list of option codes, or, for a
 * localizable text field, an object from locale to string.
 */
export type AttributeValue =
  string | number | boolean | readonly string[] | { readonly [locale: string]: string };
export type AttributeValues = { readonly [code: string]: AttributeValue | undefined };

export const ATTRIBUTE_ISSUE_CODES = [
  'attribute.unknown',
  'attribute.required',
  'attribute.type',
  'attribute.too-long',
  'attribute.out-of-range',
  'attribute.option-unknown',
  'attribute.option-duplicate',
  'attribute.locale-unknown',
  'text.invisible-character',
] as const;
export type AttributeIssueCode = (typeof ATTRIBUTE_ISSUE_CODES)[number];

/** Where and why, never the value (it can be seller text). `path` is `code` or `code.locale`. */
export interface AttributeIssue {
  readonly path: string;
  readonly code: AttributeIssueCode;
}

export type ValidationResult = Result<true, readonly AttributeIssue[]>;

const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isCalendarDate(text: string): boolean {
  const match = DATE.exec(text);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= days;
}

function isLocaleMap(value: unknown): value is { readonly [locale: string]: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkText(
  path: string,
  value: unknown,
  field: AttributeField,
  issues: AttributeIssue[],
): void {
  if (typeof value !== 'string') {
    issues.push({ path, code: 'attribute.type' });
    return;
  }
  const max = field.bounds.maxLength;
  if (max !== undefined && Array.from(value).length > max) {
    issues.push({ path, code: 'attribute.too-long' });
  }
  const plain = parsePlainText(value);
  if (!plain.ok) issues.push({ path, code: plain.error.code });
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

function checkScalar(field: AttributeField, value: unknown, issues: AttributeIssue[]): void {
  const path = field.code;
  const { min, max, options } = field.bounds;
  switch (field.dataType) {
    case 'text':
    case 'long-text':
      checkText(path, value, field, issues);
      return;
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        issues.push({ path, code: 'attribute.type' });
      } else if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
        issues.push({ path, code: 'attribute.out-of-range' });
      }
      return;
    case 'decimal': {
      if (typeof value !== 'string' || !DECIMAL.test(value)) {
        issues.push({ path, code: 'attribute.type' });
        return;
      }
      const number = Number(value);
      if ((min !== undefined && number < min) || (max !== undefined && number > max)) {
        issues.push({ path, code: 'attribute.out-of-range' });
      }
      return;
    }
    case 'boolean':
      if (typeof value !== 'boolean') issues.push({ path, code: 'attribute.type' });
      return;
    case 'date':
      if (typeof value !== 'string' || !isCalendarDate(value)) {
        issues.push({ path, code: 'attribute.type' });
      }
      return;
    case 'select':
      if (typeof value !== 'string') {
        issues.push({ path, code: 'attribute.type' });
      } else if (!(options ?? []).some((option) => option.code === value)) {
        issues.push({ path, code: 'attribute.option-unknown' });
      }
      return;
    case 'multi-select': {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        issues.push({ path, code: 'attribute.type' });
        return;
      }
      const codes = value as readonly string[];
      if (new Set(codes).size !== codes.length) {
        issues.push({ path, code: 'attribute.option-duplicate' });
      }
      if (codes.some((code) => !(options ?? []).some((option) => option.code === code))) {
        issues.push({ path, code: 'attribute.option-unknown' });
      }
      return;
    }
  }
}

/**
 * Checks `values` against `schema` (catalog design 3.3). `locales` lists the Market's locales,
 * the default first. A localizable text field takes a value per locale; only the default locale
 * is required, any other may be missing. Returns every issue found, in field order.
 */
export function validateAttributeValues(
  schema: AttributeSchema,
  values: AttributeValues,
  locales: readonly Locale[],
): ValidationResult {
  const issues: AttributeIssue[] = [];
  const known = new Set(schema.fields.map((field) => field.code));
  for (const code of Object.keys(values).sort()) {
    if (!known.has(code)) issues.push({ path: code, code: 'attribute.unknown' });
  }
  const defaultLocale = locales[0];

  for (const field of schema.fields) {
    const value = values[field.code];
    const textual = field.dataType === 'text' || field.dataType === 'long-text';

    if (field.localizable && textual) {
      if (value !== undefined && !isLocaleMap(value)) {
        issues.push({ path: field.code, code: 'attribute.type' });
        continue;
      }
      const map = value;
      const byLocale = map ?? {};
      for (const locale of Object.keys(byLocale).sort()) {
        const path = `${field.code}.${locale}`;
        if (!locales.includes(locale)) {
          issues.push({ path, code: 'attribute.locale-unknown' });
        } else if (!isBlank(byLocale[locale])) {
          checkText(path, byLocale[locale], field, issues);
        }
      }
      if (field.required && (defaultLocale === undefined || isBlank(byLocale[defaultLocale]))) {
        issues.push({
          path: defaultLocale === undefined ? field.code : `${field.code}.${defaultLocale}`,
          code: 'attribute.required',
        });
      }
      continue;
    }

    if (isBlank(value)) {
      if (field.required) issues.push({ path: field.code, code: 'attribute.required' });
      continue;
    }
    checkScalar(field, value, issues);
  }
  return issues.length === 0 ? ok(true) : err(issues);
}
