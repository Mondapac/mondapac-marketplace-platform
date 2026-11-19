import { gtinCheckDigitValid } from '../variant-gtin';
import { measureToBase } from '@mondapac/shared-kernel';
import type {
  AttributeField,
  AttributeSchema,
  AttributeValue,
  AttributeValues,
} from '@mondapac/shared-kernel';
import type { ProductTypeHandler } from '../product-type-handler';
import {
  attributeColumn,
  type AttributeColumn,
  type AttributeColumnMap,
  type ColumnMap,
  type ImportColumnKey,
} from './columns';
import type { ParsedRow } from './import-file';
import { hasControlCharacter, replaceControlCharacters } from './text-safety';

// The row check of the platform import (catalog design 14a). A pure function over one parsed row
// and the facts of the Market, so the check step and the run step read a row the same way: the
// check never saves anything, and the run asks it again for each row just before it creates the
// product (a category deactivated in between is then that row's failure, not a surprise).

/** The facts a row is checked against, read once per check or run. */
export interface CheckEnvironment {
  readonly defaultLocale: string;
  /** Default locale first. */
  readonly locales: readonly string[];
  /** Live platform categories: loose name to ids (two ids mean the name is ambiguous). */
  readonly categoriesByName: ReadonlyMap<string, readonly string[]>;
  readonly categoriesBySlug: ReadonlyMap<string, string>;
  /** The product type codes the Market offers, in configured order. */
  readonly typesOffered: readonly string[];
  readonly handlerFor: (typeCode: string) => ProductTypeHandler | undefined;
  /** The schema of the Market's default family. */
  readonly schema: AttributeSchema;
  /**
   * The schema of the feature set each live category resolves to (its own or the nearest above,
   * else the default). A category with no entry uses `schema`; `null` means its feature set
   * cannot be read, and a row in it is an error (nothing falls back silently).
   */
  readonly schemaByCategory?: ReadonlyMap<string, AttributeSchema | null>;
  readonly taxCategoryCodes: readonly string[];
}

export type IssueSeverity = 'error' | 'warning';
export type IssueColumn = ImportColumnKey | AttributeColumn | 'row';

/** One problem in one cell. `value` is the cell as sent, shortened and cleaned for display. */
export interface RowIssue {
  readonly severity: IssueSeverity;
  /** The column (`attr[<code>]` for an attribute), or `row` for a problem of the row as a whole. */
  readonly column: IssueColumn;
  readonly code: string;
  readonly value: string;
  /** `duplicate-in-file` only: the first row with the same title and brand. */
  readonly otherRow?: number;
}

/** What the run needs to create the product: the draft content and the type. */
export interface ImportPlan {
  readonly typeCode: string;
  readonly content: Readonly<Record<string, unknown>>;
}

export interface RowSummary {
  readonly title: string;
  readonly category: string;
  readonly typeCode: string;
  readonly brand: string;
}

export interface CheckedRow {
  readonly rowNumber: number;
  readonly state: 'ready' | 'error';
  readonly issues: readonly RowIssue[];
  readonly summary: RowSummary;
  /** Present when `state` is `ready`. */
  readonly plan: ImportPlan | null;
}

/** The longest a value is kept in an issue or a summary. */
export const DISPLAY_VALUE_MAX = 80;
const TITLE_MAX = 120;
const BRAND_MAX = 120;
const UNIT_SIZE_MAX = 40;
const URL_MAX = 2000;
const UNPAIRED_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** A cell made safe to show and store in a report: no control characters, at most 80 characters. */
export function displayValue(value: string): string {
  const clean = replaceControlCharacters(value).trim();
  return clean.length > DISPLAY_VALUE_MAX ? `${clean.slice(0, DISPLAY_VALUE_MAX - 1)}…` : clean;
}

/** A name compared loosely: case, accents and runs of spaces do not matter. */
export function looseName(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export { gtinCheckDigitValid };

function cellOf(row: ParsedRow, map: ColumnMap, key: ImportColumnKey): string {
  const index = map[key];
  return index === undefined ? '' : (row.cells[index] ?? '').trim();
}

/** The attribute field of this code when it holds plain text, else null (then the value is not stored). */
function isPlainHttps(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function textField(
  schema: AttributeSchema,
  code: string,
): AttributeSchema['fields'][number] | null {
  const field = schema.fields.find((candidate) => candidate.code === code);
  return field !== undefined && (field.dataType === 'text' || field.dataType === 'long-text')
    ? field
    : null;
}

/** Which column an attribute issue belongs to. */
function columnOfAttribute(path: string, fileAttributes: AttributeColumnMap): IssueColumn {
  const code = path.split('.')[0];
  if (code !== undefined && fileAttributes.has(code)) return attributeColumn(code);
  switch (code) {
    case 'brand':
      return 'brand';
    case 'description':
      return 'description';
    case 'gtin':
      return 'gtin';
    case 'unit-size':
      return 'unitSize';
    default:
      return 'row';
  }
}

/**
 * Checks one row. Errors keep it out of the import; warnings let it in and say what was not
 * stored or was defaulted. Never throws, never reads anything but its arguments.
 */
export function checkRow(
  row: ParsedRow,
  map: ColumnMap,
  env: CheckEnvironment,
  fileAttributes: AttributeColumnMap = NO_ATTRIBUTE_COLUMNS,
): CheckedRow {
  const issues: RowIssue[] = [];
  const add = (severity: IssueSeverity, column: IssueColumn, code: string, value: string): void => {
    issues.push({ severity, column, code, value: displayValue(value) });
  };

  const title = cellOf(row, map, 'title').normalize('NFC');
  const categoryText = cellOf(row, map, 'category');
  const typeText = cellOf(row, map, 'type');
  const description = cellOf(row, map, 'description');
  const brand = cellOf(row, map, 'brand');
  const gtin = cellOf(row, map, 'gtin').replace(/[\s-]/g, '');
  const unitSize = cellOf(row, map, 'unitSize');
  const imageUrl = cellOf(row, map, 'imageUrl');
  const taxText = cellOf(row, map, 'taxCategory');

  // Text that PostgreSQL's jsonb refuses or that hides a character: the draft could not store it.
  const unstorable = row.cells.some(
    (cell) => hasControlCharacter(cell) || UNPAIRED_SURROGATE.test(cell),
  );
  if (unstorable) {
    const unsafe = (index: number | undefined): boolean => {
      const cell = index === undefined ? '' : (row.cells[index] ?? '');
      return hasControlCharacter(cell) || UNPAIRED_SURROGATE.test(cell);
    };
    const textColumn = IMPORT_TEXT_COLUMNS.find((key) => unsafe(map[key]));
    const attributeCode = [...fileAttributes].find(([, index]) => unsafe(index))?.[0];
    const column: IssueColumn | undefined =
      textColumn ?? (attributeCode === undefined ? undefined : attributeColumn(attributeCode));
    add('error', column ?? 'row', 'text.invalid-characters', '');
  }

  if (title === '') add('error', 'title', 'required', '');
  else if (title.length > TITLE_MAX) add('error', 'title', 'too-long', title);

  let categoryId: string | null = null;
  if (categoryText === '') add('error', 'category', 'required', '');
  else {
    const byName = env.categoriesByName.get(looseName(categoryText)) ?? [];
    const bySlug = env.categoriesBySlug.get(categoryText.toLowerCase());
    const found = byName.length > 0 ? byName : bySlug === undefined ? [] : [bySlug];
    if (found.length === 0) add('error', 'category', 'category.unknown', categoryText);
    else if (found.length > 1) add('error', 'category', 'category.ambiguous', categoryText);
    else categoryId = found[0]!;
  }

  // The schema is the one of the feature set the category resolves to (attributes plan A4).
  let schema = env.schema;
  if (categoryId !== null) {
    const specific = env.schemaByCategory?.get(categoryId);
    if (specific === null) add('error', 'category', 'family.unavailable', categoryText);
    else if (specific !== undefined) schema = specific;
  }

  let typeCode: string | null = null;
  if (typeText === '') add('error', 'type', 'required', '');
  else {
    const wanted = looseName(typeText);
    typeCode = env.typesOffered.find((code) => looseName(code) === wanted) ?? null;
    if (typeCode === null) add('error', 'type', 'product-type.unknown', typeText);
    else if (env.handlerFor(typeCode)?.variantModel !== 'single') {
      // A product with variants needs option values a flat file cannot carry (design 14a).
      add('error', 'type', 'product-type.needs-variants', typeText);
      typeCode = null;
    }
  }

  if (brand.length > BRAND_MAX) add('error', 'brand', 'too-long', brand);
  if (unitSize.length > UNIT_SIZE_MAX) add('error', 'unitSize', 'too-long', unitSize);

  if (gtin !== '') {
    if (!/^\d+$/.test(gtin) || ![8, 12, 13, 14].includes(gtin.length)) {
      add('error', 'gtin', 'gtin.length', cellOf(row, map, 'gtin'));
    } else if (!gtinCheckDigitValid(gtin)) {
      add('error', 'gtin', 'gtin.check-digit', cellOf(row, map, 'gtin'));
    }
  }

  if (imageUrl !== '') {
    const https = isPlainHttps(imageUrl);
    if (!https || imageUrl.length > URL_MAX)
      add('error', 'imageUrl', 'image-url.not-https', imageUrl);
    // A link is never fetched (design 14, AC 40): the photo is added in the product editor.
    else add('warning', 'imageUrl', 'image-url.not-fetched', imageUrl);
  }

  let taxCategoryCode = env.taxCategoryCodes[0] ?? '';
  if (taxText === '') {
    if (taxCategoryCode !== '')
      add('warning', 'taxCategory', 'tax-category.default-used', taxCategoryCode);
  } else {
    const match = env.taxCategoryCodes.find((code) => looseName(code) === looseName(taxText));
    if (match === undefined) add('error', 'taxCategory', 'tax-category.unknown', taxText);
    else taxCategoryCode = match;
  }

  // The attribute values the file can carry, then the schema's own check of them.
  const attributeValues: Record<string, unknown> = {};
  const put = (code: string, value: string, column: ImportColumnKey, warn = true): void => {
    if (value === '') return;
    const field = textField(schema, code);
    if (field === null) {
      // The Market's family has no such attribute: the value is checked and not stored.
      if (warn) add('warning', column, 'column.not-stored', value);
      return;
    }
    attributeValues[code] = field.localizable ? { [env.defaultLocale]: value } : value;
  };
  put('brand', brand, 'brand');
  // The description is always stored as the revision text; the attribute is filled when the family has one.
  put('description', description, 'description', false);
  put('gtin', gtin, 'gtin');
  put('unit-size', unitSize, 'unitSize');
  for (const [code, index] of fileAttributes) {
    const cell = (row.cells[index] ?? '').trim();
    if (cell === '') continue;
    const column = attributeColumn(code);
    const field = schema.fields.find((candidate) => candidate.code === code);
    if (field === undefined || Object.hasOwn(attributeValues, code)) {
      // The feature set has no such attribute, or a dedicated column already filled it: not stored.
      add('warning', column, 'column.not-stored', cell);
      continue;
    }
    const parsed = parseCell(field, cell, env);
    if (parsed.ok) attributeValues[code] = parsed.value;
    else add('error', column, parsed.code, cell);
  }

  if (typeCode !== null) {
    const handler = env.handlerFor(typeCode);
    const validated = handler?.validateAttributes(
      schema,
      attributeValues as AttributeValues,
      env.locales,
    );
    if (validated !== undefined && !validated.ok) {
      for (const issue of validated.error) {
        const column = columnOfAttribute(issue.path, fileAttributes);
        // One problem per column is enough for the admin to fix.
        if (
          !issues.some((existing) => existing.severity === 'error' && existing.column === column)
        ) {
          add(
            'error',
            column,
            issue.code,
            column === 'row' ? '' : cellText(row, map, fileAttributes, column),
          );
        }
      }
    }
  }

  const summary: RowSummary = {
    title: displayValue(title),
    category: displayValue(categoryText),
    typeCode: typeCode ?? displayValue(typeText),
    brand: displayValue(brand),
  };
  const hasError = issues.some((issue) => issue.severity === 'error');
  if (hasError || typeCode === null || categoryId === null) {
    return { rowNumber: row.rowNumber, state: 'error', issues, summary, plan: null };
  }
  const texts: Record<string, string> = { name: title };
  if (description !== '') texts['description'] = description;
  return {
    rowNumber: row.rowNumber,
    state: 'ready',
    issues,
    summary,
    plan: {
      typeCode,
      content: {
        texts: { [env.defaultLocale]: texts },
        categoryIds: [categoryId],
        taxCategoryCode,
        attributeValues,
        imageIds: [],
      },
    },
  };
}

const NO_ATTRIBUTE_COLUMNS: AttributeColumnMap = new Map();

/** The cell behind a column: a dedicated column, or an `attr[<code>]` one. */
function cellText(
  row: ParsedRow,
  map: ColumnMap,
  fileAttributes: AttributeColumnMap,
  column: ImportColumnKey | AttributeColumn,
): string {
  if (column.startsWith('attr[')) {
    const index = fileAttributes.get(column.slice(5, -1));
    return index === undefined ? '' : (row.cells[index] ?? '').trim();
  }
  return cellOf(row, map, column as ImportColumnKey);
}

type ParsedCell =
  | { readonly ok: true; readonly value: AttributeValue }
  | { readonly ok: false; readonly code: string };

const INTEGER_CELL = /^-?\d{1,15}$/;
const DECIMAL_CELL = /^-?\d{1,15}(?:\.\d{1,9})?$/;
const DATE_CELL = /^\d{4}-\d{2}-\d{2}$/;
const MEASURE_CELL = /^(\d{1,15}(?:\.\d{1,9})?)\s*(\S.{0,19})?$/;
const YES = new Set(['yes', 'true', '1']);
const NO = new Set(['no', 'false', '0']);

interface OptionIndex {
  readonly codes: ReadonlySet<string>;
  /** Loose label to the codes that carry it (more than one means the label is ambiguous). */
  readonly byLabel: ReadonlyMap<string, readonly string[]>;
}

// Built once per field and default language: a file of 5,000 rows names options 200,000 times, and
// a lookup must not read every label of every option each time.
const OPTION_INDEXES = new WeakMap<AttributeField, Map<string, OptionIndex>>();

function optionIndexOf(field: AttributeField, defaultLocale: string): OptionIndex {
  const byLocale = OPTION_INDEXES.get(field) ?? new Map<string, OptionIndex>();
  const known = byLocale.get(defaultLocale);
  if (known !== undefined) return known;
  const options = field.bounds.options ?? [];
  const byLabel = new Map<string, string[]>();
  for (const option of options) {
    const seen = new Set<string>();
    for (const [locale, label] of Object.entries(option.labels ?? {})) {
      if (locale !== defaultLocale && !locale.toLowerCase().startsWith('en')) continue;
      const key = looseName(label);
      if (seen.has(key)) continue;
      seen.add(key);
      byLabel.set(key, [...(byLabel.get(key) ?? []), option.code]);
    }
  }
  const index: OptionIndex = { codes: new Set(options.map((option) => option.code)), byLabel };
  byLocale.set(defaultLocale, index);
  OPTION_INDEXES.set(field, byLocale);
  return index;
}

/** The most options one multi-select cell may list. */
const MULTI_SELECT_PARTS_MAX = 50;

/** The option of a select field a cell names: its code, or its label in English or the default locale. */
function optionOf(field: AttributeField, cell: string, env: CheckEnvironment): string | null {
  const index = optionIndexOf(field, env.defaultLocale);
  const lower = cell.toLowerCase();
  if (index.codes.has(lower)) return lower;
  const found = index.byLabel.get(looseName(cell));
  return found?.length === 1 ? found[0]! : null;
}

/**
 * Reads one `attr[<code>]` cell as the value of its field: text as is (the default locale of a
 * localizable field), whole and decimal numbers, yes/no, a select option by code or English label
 * (several, separated by `;`, for a multi-select), a date as `YYYY-MM-DD`, a measure as `500 g`.
 * The schema's own check (bounds, units, precision, claim-free text) runs after this on the result.
 */
function parseCell(field: AttributeField, cell: string, env: CheckEnvironment): ParsedCell {
  const bad = (code = 'attribute.type'): ParsedCell => ({ ok: false, code });
  switch (field.dataType) {
    case 'text':
    case 'long-text':
      return {
        ok: true,
        value: field.localizable
          ? { [env.defaultLocale]: cell.normalize('NFC') }
          : cell.normalize('NFC'),
      };
    case 'integer': {
      if (!INTEGER_CELL.test(cell)) return bad();
      const value = Number(cell);
      return Number.isSafeInteger(value) ? { ok: true, value } : bad();
    }
    case 'decimal':
      return DECIMAL_CELL.test(cell) ? { ok: true, value: cell } : bad();
    case 'boolean': {
      const word = cell.toLowerCase();
      if (YES.has(word)) return { ok: true, value: true };
      return NO.has(word) ? { ok: true, value: false } : bad();
    }
    case 'date':
      return DATE_CELL.test(cell) ? { ok: true, value: cell } : bad();
    case 'select': {
      const code = optionOf(field, cell, env);
      return code === null ? bad('attribute.option-unknown') : { ok: true, value: code };
    }
    case 'multi-select': {
      const codes: string[] = [];
      const parts = cell.split(';').map((piece) => piece.trim());
      if (parts.length > MULTI_SELECT_PARTS_MAX) return bad();
      for (const part of parts) {
        if (part === '') continue;
        const code = optionOf(field, part, env);
        if (code === null) return bad('attribute.option-unknown');
        if (codes.includes(code)) return bad('attribute.option-duplicate');
        codes.push(code);
      }
      return codes.length === 0 ? bad() : { ok: true, value: codes };
    }
    case 'measure': {
      const settings = field.measure;
      const match = MEASURE_CELL.exec(cell);
      if (settings === undefined || match === null) return bad();
      const text = (match[2] ?? '').trim();
      const unit =
        text === ''
          ? settings.defaultUnit
          : settings.units.find((candidate) => candidate.toLowerCase() === text.toLowerCase());
      if (unit === undefined) return bad('attribute.unit-unknown');
      // The value is stored in the base unit of its dimension ("1.5 kg" is "1500"), exactly.
      const base = measureToBase(match[1]!, unit, settings.decimals);
      return base === null
        ? bad('attribute.precision')
        : { ok: true, value: { value: base, unit } };
    }
  }
}

const IMPORT_TEXT_COLUMNS: readonly ImportColumnKey[] = [
  'title',
  'category',
  'type',
  'description',
  'brand',
  'gtin',
  'unitSize',
  'imageUrl',
  'taxCategory',
];

/** The key two rows share when they are the same product in the file. */
export function duplicateKey(summary: RowSummary): string {
  return `${looseName(summary.title)}|${looseName(summary.brand)}`;
}

/**
 * Marks every row whose title and brand repeat an earlier row of the file (design 14a): the
 * later row is an error that names the first one. Returns new rows; the input is not changed.
 */
export function markDuplicates(rows: readonly CheckedRow[]): CheckedRow[] {
  const first = new Map<string, number>();
  return rows.map((row) => {
    if (row.summary.title === '') return row;
    const key = duplicateKey(row.summary);
    const earlier = first.get(key);
    if (earlier === undefined) {
      first.set(key, row.rowNumber);
      return row;
    }
    return {
      ...row,
      state: 'error',
      plan: null,
      issues: [
        ...row.issues,
        {
          severity: 'error',
          column: 'title',
          code: 'duplicate-in-file',
          value: row.summary.title,
          otherRow: earlier,
        },
      ],
    };
  });
}

/** The counts of a check: what the tiles show. A row with only warnings is ready. */
export function countRows(rows: readonly CheckedRow[]): {
  readonly rows: number;
  readonly ready: number;
  readonly errors: number;
  readonly warnings: number;
} {
  let ready = 0;
  let errors = 0;
  let warnings = 0;
  for (const row of rows) {
    if (row.state === 'ready') ready += 1;
    else errors += 1;
    if (row.issues.some((issue) => issue.severity === 'warning')) warnings += 1;
  }
  return { rows: rows.length, ready, errors, warnings };
}
