import type { AttributeField, AttributeValues } from '@mondapac/shared-kernel';
import { chooseAxes, axisCandidates } from '../variant-axes';
import { MAX_DESCRIPTION_CHARS } from '../offer';
import { optionKeyOf } from '../revision-freeze';
import { normalizeGtin } from '../variant-gtin';
import { isPositiveInt, VARIANT_FIELD_LIMITS } from '../variant-fields';
import type { ParsedRow } from '../platform-import/import-file';
import {
  displayValue,
  looseName,
  type CheckEnvironment,
  type IssueSeverity,
} from '../platform-import/row-check';
import {
  hasControlCharacter,
  hasUnpairedSurrogate,
} from '../platform-import/text-safety';
import { fileLabelOf, MAX_ISSUES_PER_ROW } from '../import-jobs/import-job-core';
import { headerOfKey, type SellerColumnKey, type SellerColumnMap } from './columns';

// The row check of the seller import (catalog design 14c). Pure functions over the parsed rows, the
// Market's facts and the facts about the seller's own Offers, so the check step and the run step read
// a file the same way: the check never saves anything, and the run asks again for each group just
// before it writes (an Offer taken, a category retired or a product paused in between is then that
// group's failure, not a surprise).
//
// What this file never reads (design 14c, "Refused columns" and "Price, stock and Cost"): any
// certification, handling, attestation, tag, status, price, cost or stock cell. The column map
// lists such a column as ignored; the plan has no field for any of them.

/** The facts about one of the seller's own Offers that the check needs (read by the use case). */
export interface ExistingOfferFact {
  readonly offerId: string;
  readonly productId: string;
  readonly sellerSku: string;
  readonly productScope: 'PLATFORM' | 'SELLER';
  readonly productTypeCode: string;
  /** The live variants of a SELLER product with their option keys (empty for a Simple product). */
  readonly variants: readonly { readonly variantId: string; readonly optionKey: string }[];
  /** The axes of the published revision, when the product was ever published (they stay, V3). */
  readonly publishedAxes: readonly string[] | null;
}

/** A PLATFORM product a seller may sell on: published, not retired, not paused (OFR-03). */
export interface CatalogueProductFact {
  readonly productId: string;
  readonly typeCode: string;
}

export interface SellerCheckFacts {
  /** The seller's own non-deleted Offers by Seller SKU (exact). */
  readonly offersBySku: ReadonlyMap<string, ExistingOfferFact>;
  /** The product ids the seller already has an Offer on, with the SKU of that Offer. */
  readonly ownSkuByProductId: ReadonlyMap<string, string>;
  /** Eligible PLATFORM products by public product code (any other code is simply absent). */
  readonly catalogueByCode: ReadonlyMap<string, CatalogueProductFact>;
}

export interface SellerCheckEnvironment extends CheckEnvironment {
  /** The condition codes an Offer may carry in this Market. */
  readonly conditions: readonly string[];
  readonly maxVariantsPerProduct: number;
  readonly maxVariantAttributes: number;
  /** SEL-12: the types the seller may sell; `all` when the seller is not restricted. */
  readonly allowedTypes: 'all' | ReadonlySet<string>;
}

export interface SellerRowIssue {
  readonly severity: IssueSeverity;
  /** The column key or header token (`title`, `option[size]`), or `row` for the row as a whole. */
  readonly column: string;
  readonly code: string;
  /** The cell as sent, shortened and cleaned for display. */
  readonly value: string;
  /** `duplicate-in-file` and `import.duplicate-row`: the other row. */
  readonly otherRow?: number;
}

export interface SellerRowSummary {
  readonly sku: string;
  readonly title: string;
  readonly productCode: string;
  readonly typeCode: string;
  /** The option labels of a variant row, e.g. `L / Red`. */
  readonly options: string;
  /** The cleaned photo names the row's group lists (first row of a group only; at most 8). */
  readonly images: readonly string[];
}

/** What a group does to the product: only what the file gave, an empty cell is `null` (leave it). */
export interface SellerProductPatch {
  /** The product type given in the file; for an update this is the existing product's. */
  readonly typeCode: string;
  readonly title: string | null;
  readonly shortDescription: string | null;
  readonly description: string | null;
  readonly categoryId: string | null;
  readonly taxCategoryCode: string | null;
  /** Attribute code to value, only the attributes the file gave. */
  readonly attributeValues: Readonly<Record<string, unknown>>;
  /** The cleaned photo names; the photo step adds them after the run. */
  readonly imageNames: readonly string[];
  /** The option attributes the product varies on (empty for a Simple product). */
  readonly axes: readonly string[];
}

/** What a row does to a variant (the V4 per-variant fields). */
export interface SellerVariantPlan {
  readonly rowNumber: number;
  readonly optionValues: Readonly<Record<string, string>>;
  readonly optionKey: string;
  /** The existing variant the option key found, or null for a new one. */
  readonly existingVariantId: string | null;
  readonly gtin: string | null;
  readonly shippingWeightGrams: number | null;
  readonly shippingLengthMm: number | null;
  readonly shippingWidthMm: number | null;
  readonly shippingHeightMm: number | null;
}

/**
 * The plan of one group. **It has no field for a certification, a tag, a claim decision, a basis, a
 * certificate, a handling, an attestation, a self-declaration, a status, a publish flag, a price, a
 * cost or a stock level** (design 14c): the row use cases have closed inputs without them too.
 */
export interface SellerGroupPlan {
  readonly mode: 'my-products' | 'sell-from-catalogue';
  readonly kind: 'create' | 'update';
  readonly groupRow: number;
  readonly sellerSku: string;
  /** Null: leave the stored value (an empty cell on an update); on a create the check made it a code. */
  readonly conditionCode: string | null;
  readonly offerDescription: string | null;
  readonly existing: ExistingOfferFact | null;
  /** `sell-from-catalogue`: the product the Offer is on. */
  readonly catalogueProduct: CatalogueProductFact | null;
  /** `my-products`. */
  readonly product: SellerProductPatch | null;
  readonly variants: readonly SellerVariantPlan[];
}

export interface CheckedSellerRow {
  readonly rowNumber: number;
  readonly groupRow: number;
  readonly state: 'ready' | 'error';
  /** `create` or `update` for a ready row. */
  readonly plan: 'create' | 'update' | null;
  readonly issues: readonly SellerRowIssue[];
  readonly summary: SellerRowSummary;
}

export interface CheckedSellerGroup {
  readonly groupRow: number;
  readonly rows: readonly CheckedSellerRow[];
  /** Present when every row of the group is ready. */
  readonly plan: SellerGroupPlan | null;
}

// ---------------------------------------------------------------------------------------------
// Cells

interface Cells {
  readonly rowNumber: number;
  readonly text: Readonly<Record<SellerColumnKey, string>>;
  /** Option code to the cell. */
  readonly options: Readonly<Record<string, string>>;
  readonly attributes: Readonly<Record<string, string>>;
  /** A control character or an unpaired surrogate in a cell that is read. */
  readonly unstorable: boolean;
}

function cleanCell(value: string | undefined): string {
  return (value ?? '').normalize('NFC').trim();
}

function readCells(row: ParsedRow, map: SellerColumnMap): Cells {
  const text = {} as Record<SellerColumnKey, string>;
  let unstorable = false;
  const read = (index: number | undefined): string => {
    const raw = index === undefined ? '' : (row.cells[index] ?? '');
    if (hasControlCharacter(raw) || hasUnpairedSurrogate(raw)) unstorable = true;
    return cleanCell(raw);
  };
  for (const key of SELLER_KEYS) text[key] = read(map.fixed[key]);
  const options: Record<string, string> = {};
  for (const column of map.options) options[column.code] = read(column.index);
  const attributes: Record<string, string> = {};
  for (const column of map.attributes) attributes[column.code] = read(column.index);
  return { rowNumber: row.rowNumber, text, options, attributes, unstorable };
}

const SELLER_KEYS: readonly SellerColumnKey[] = [
  'sku',
  'condition',
  'offerDescription',
  'productCode',
  'title',
  'category',
  'type',
  'shortDescription',
  'description',
  'brand',
  'taxCategory',
  'images',
  'gtin',
  'weight',
  'length',
  'width',
  'height',
];

/** The cells of a group are compared after NFC and with runs of spaces folded. */
const fold = (value: string): string => value.replace(/\s+/g, ' ');

// ---------------------------------------------------------------------------------------------
// Groups

export interface SellerGroupRows {
  readonly groupRow: number;
  readonly rows: readonly Cells[];
  /** The rows are a later block of a SKU that already had one (`import.group-split`). */
  readonly split: boolean;
}

/**
 * Cuts the rows into groups. In `my-products` the group key is the Seller SKU: one product has one
 * Offer and one Offer has one SKU, so all rows with the same SKU are one product and each row is a
 * variant; a group's rows must be contiguous, and a SKU that comes back after another one is a split
 * (the later block). In `sell-from-catalogue` every row is its own group.
 */
export function groupSellerRows(
  rows: readonly ParsedRow[],
  map: SellerColumnMap,
): SellerGroupRows[] {
  const groups: { groupRow: number; rows: Cells[]; split: boolean; sku: string }[] = [];
  const closed = new Set<string>();
  for (const parsed of rows) {
    const cells = readCells(parsed, map);
    const sku = cells.text.sku;
    const current = groups.at(-1);
    if (map.mode === 'my-products' && current !== undefined && sku !== '' && current.sku === sku) {
      current.rows.push(cells);
      continue;
    }
    if (current !== undefined) closed.add(current.sku);
    groups.push({
      groupRow: cells.rowNumber,
      rows: [cells],
      split: map.mode === 'my-products' && sku !== '' && closed.has(sku),
      sku,
    });
  }
  return groups.map(({ groupRow, rows: groupRows, split }) => ({
    groupRow,
    rows: groupRows,
    split,
  }));
}

// ---------------------------------------------------------------------------------------------
// Checking

const SKU_PATTERN = /^[!-~]{1,64}$/;
const TITLE_MAX = 120;
const BRAND_MAX = 120;
const SHORT_DESCRIPTION_MAX = 300;
export const MAX_IMAGE_NAMES = 8;
const BOOLEAN_YES = new Set(['yes', 'true', '1', 'y']);
const BOOLEAN_NO = new Set(['no', 'false', '0', 'n']);
const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i;

/** A label compared loosely: NFC, case and runs of spaces do not matter. */
export function looseLabel(value: string): string {
  return fold(value.normalize('NFC').toLowerCase()).trim();
}

/** Accumulates the issues of one row. */
class Issues {
  readonly list: SellerRowIssue[] = [];
  add(
    severity: IssueSeverity,
    column: string,
    code: string,
    value = '',
    otherRow?: number,
  ): void {
    this.list.push({
      severity,
      column,
      code,
      value: displayValue(value),
      ...(otherRow === undefined ? {} : { otherRow }),
    });
  }
  get hasError(): boolean {
    return this.list.some((issue) => issue.severity === 'error');
  }
}

function fieldOf(env: CheckEnvironment, code: string): AttributeField | undefined {
  return env.schema.fields.find((field) => field.code === code);
}

/** The option code of a select value given as a label (default locale) or a code, else null. */
function optionCodeOf(field: AttributeField, value: string, defaultLocale: string): string | null {
  const wanted = looseLabel(value);
  for (const option of field.bounds.options ?? []) {
    if (looseLabel(option.code) === wanted) return option.code;
    const label = option.labels?.[defaultLocale];
    if (label !== undefined && looseLabel(label) === wanted) return option.code;
  }
  return null;
}

function optionLabelOf(field: AttributeField, code: string, defaultLocale: string): string {
  const option = field.bounds.options?.find((candidate) => candidate.code === code);
  return option?.labels?.[defaultLocale] ?? code;
}

/** The attribute value a cell gives for a field, or the code of what is wrong with it. */
function attributeValueOf(
  field: AttributeField,
  cell: string,
  defaultLocale: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: string } {
  switch (field.dataType) {
    case 'text':
    case 'long-text':
      return {
        ok: true,
        value: field.localizable ? { [defaultLocale]: cell } : cell,
      };
    case 'integer': {
      const value = Number(cell);
      return /^-?\d+$/.test(cell) && Number.isSafeInteger(value)
        ? { ok: true, value }
        : { ok: false, code: 'attribute.type' };
    }
    case 'decimal':
      return DECIMAL.test(cell) ? { ok: true, value: cell } : { ok: false, code: 'attribute.type' };
    case 'boolean': {
      const folded = cell.toLowerCase();
      if (BOOLEAN_YES.has(folded)) return { ok: true, value: true };
      if (BOOLEAN_NO.has(folded)) return { ok: true, value: false };
      return { ok: false, code: 'attribute.type' };
    }
    case 'select': {
      const code = optionCodeOf(field, cell, defaultLocale);
      return code === null
        ? { ok: false, code: 'attribute.option-unknown' }
        : { ok: true, value: code };
    }
    case 'multi-select': {
      const codes: string[] = [];
      for (const part of cell.split('|')) {
        if (part.trim() === '') continue;
        const code = optionCodeOf(field, part, defaultLocale);
        if (code === null) return { ok: false, code: 'attribute.option-unknown' };
        if (!codes.includes(code)) codes.push(code);
      }
      return { ok: true, value: codes };
    }
    case 'date':
      return { ok: true, value: cell };
    case 'measure':
      // Not importable from a flat file: the column is ignored by the column map.
      return { ok: false, code: 'attribute.type' };
  }
}

/** The codes of the attributes a file column may fill: not an axis, not a measure. */
export function attributeColumnCodes(env: CheckEnvironment): ReadonlySet<string> {
  return new Set(
    env.schema.fields
      .filter(
        (field) =>
          !(field.isVariantOption && field.dataType === 'select') && field.dataType !== 'measure',
      )
      .map((field) => field.code),
  );
}

/** The codes of the axis candidates of the default family: what an `Option[...]` column may name. */
export function optionColumnCodes(env: CheckEnvironment): ReadonlySet<string> {
  return new Set(axisCandidates(env.schema));
}

function sameCell(a: string, b: string): boolean {
  return fold(a) === fold(b);
}

function imageNamesOf(
  cell: string,
  issues: Issues,
  severityFor: (code: string) => IssueSeverity = () => 'error',
): string[] {
  const names: string[] = [];
  const keys = new Set<string>();
  for (const part of cell.split('|')) {
    const raw = part.trim();
    if (raw === '') continue;
    if (URL_LIKE.test(raw)) {
      // A link is never fetched (design 14c): the photo is added in the photo step or the editor.
      issues.add('warning', 'images', 'image-url.not-fetched', raw);
      continue;
    }
    const name = fileLabelOf(raw);
    const key = name.toLowerCase();
    if (keys.has(key)) continue;
    keys.add(key);
    names.push(name);
  }
  if (names.length > MAX_IMAGE_NAMES) {
    issues.add(severityFor('too-many'), 'images', 'too-many', String(names.length));
    return names.slice(0, MAX_IMAGE_NAMES);
  }
  return names;
}

function summaryOf(
  cells: Cells,
  typeCode: string,
  options: string,
  images: readonly string[],
): SellerRowSummary {
  return {
    sku: displayValue(cells.text.sku),
    title: displayValue(cells.text.title),
    productCode: displayValue(cells.text.productCode),
    typeCode: displayValue(typeCode),
    options: displayValue(options),
    images: images.slice(0, MAX_IMAGE_NAMES).map((name) => displayValue(name)),
  };
}

/** Sorts a row's issues errors first and keeps the most the table holds. */
function boundedIssues(list: readonly SellerRowIssue[]): SellerRowIssue[] {
  return [...list]
    .sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'))
    .slice(0, MAX_ISSUES_PER_ROW);
}

interface GroupOutcome {
  readonly perRow: ReadonlyMap<number, Issues>;
  readonly summaries: ReadonlyMap<number, SellerRowSummary>;
  readonly plan: SellerGroupPlan | null;
}

function finish(group: SellerGroupRows, outcome: GroupOutcome): CheckedSellerGroup {
  const failed = group.rows.some((cells) => outcome.perRow.get(cells.rowNumber)?.hasError === true);
  const rows: CheckedSellerRow[] = group.rows.map((cells) => {
    const issues = outcome.perRow.get(cells.rowNumber) ?? new Issues();
    const own = issues.hasError;
    const list = [...issues.list];
    // One error in a group fails the whole group: a product is created and saved whole.
    if (failed && !own) {
      list.push({ severity: 'error', column: 'row', code: 'import.group-error', value: '' });
    }
    const state: 'ready' | 'error' = failed ? 'error' : 'ready';
    return {
      rowNumber: cells.rowNumber,
      groupRow: group.groupRow,
      state,
      plan: failed ? null : (outcome.plan?.kind ?? null),
      issues: boundedIssues(list),
      summary:
        outcome.summaries.get(cells.rowNumber) ??
        summaryOf(cells, cells.text.type, '', []),
    };
  });
  return { groupRow: group.groupRow, rows, plan: failed ? null : outcome.plan };
}

/**
 * Checks one group of a `my-products` file against the Market's facts and the seller's Offer found by
 * the SKU. Never throws, never reads anything but its arguments.
 */
export function checkProductGroup(
  group: SellerGroupRows,
  env: SellerCheckEnvironment,
  facts: SellerCheckFacts,
): CheckedSellerGroup {
  const rows = group.rows;
  const first = rows[0]!;
  const sku = first.text.sku;
  const perRow = new Map<number, Issues>(rows.map((cells) => [cells.rowNumber, new Issues()]));
  const at = (cells: Cells): Issues => perRow.get(cells.rowNumber)!;
  const firstIssues = at(first);
  const summaries = new Map<number, SellerRowSummary>();

  for (const cells of rows) {
    if (cells.unstorable) at(cells).add('error', 'row', 'text.invalid-characters');
  }
  if (group.split) {
    for (const cells of rows) at(cells).add('error', 'sku', 'import.group-split', cells.text.sku);
  }

  // The key: the SKU, and what it finds.
  let existing: ExistingOfferFact | null = null;
  if (sku === '') firstIssues.add('error', 'sku', 'required');
  else if (!SKU_PATTERN.test(sku)) firstIssues.add('error', 'sku', 'sku.invalid', sku);
  else {
    existing = facts.offersBySku.get(sku) ?? null;
    if (existing !== null && existing.productScope !== 'SELLER') {
      firstIssues.add('error', 'sku', 'import.wrong-mode', sku);
    }
  }
  const kind: 'create' | 'update' = existing === null ? 'create' : 'update';
  const creating = kind === 'create';

  // Product cells come from the first row; the other rows of the group repeat them or leave them empty.
  const productKeys = [
    'title',
    'category',
    'type',
    'shortDescription',
    'description',
    'brand',
    'taxCategory',
    'images',
    'condition',
    'offerDescription',
  ] as const;
  for (const cells of rows.slice(1)) {
    for (const key of productKeys) {
      const value = cells.text[key];
      if (value !== '' && !sameCell(value, first.text[key])) {
        at(cells).add('error', key, 'import.group-mismatch', value);
      }
    }
    for (const [code, value] of Object.entries(cells.attributes)) {
      if (value !== '' && !sameCell(value, first.attributes[code] ?? '')) {
        at(cells).add('error', `attribute[${code}]`, 'import.group-mismatch', value);
      }
    }
  }

  const text = first.text;

  // Type: a code of the Market's list; once a product exists it cannot change.
  let typeCode: string | null = null;
  if (text.type === '') {
    if (creating) firstIssues.add('error', 'type', 'required');
    else typeCode = existing!.productTypeCode;
  } else {
    const wanted = looseName(text.type);
    typeCode = env.typesOffered.find((code) => looseName(code) === wanted) ?? null;
    if (typeCode === null) firstIssues.add('error', 'type', 'product-type.unknown', text.type);
    else if (!creating && typeCode !== existing!.productTypeCode) {
      firstIssues.add('error', 'type', 'import.type-locked', text.type);
      typeCode = existing!.productTypeCode;
    }
  }
  const handler = typeCode === null ? undefined : env.handlerFor(typeCode);
  if (typeCode !== null && handler === undefined) {
    firstIssues.add('error', 'type', 'product-type.unknown', typeCode);
  }
  if (
    typeCode !== null &&
    env.allowedTypes !== 'all' &&
    !env.allowedTypes.has(typeCode) &&
    !firstIssues.hasError
  ) {
    firstIssues.add('error', 'type', 'type.not-allowed', typeCode);
  }

  // Title, texts, brand.
  if (text.title === '') {
    if (creating) firstIssues.add('error', 'title', 'required');
  } else if (text.title.length > TITLE_MAX) firstIssues.add('error', 'title', 'too-long', text.title);
  if (text.shortDescription.length > SHORT_DESCRIPTION_MAX) {
    firstIssues.add('error', 'shortDescription', 'too-long', text.shortDescription);
  }
  if (text.brand.length > BRAND_MAX) firstIssues.add('error', 'brand', 'too-long', text.brand);

  // Category.
  let categoryId: string | null = null;
  if (text.category === '') {
    if (creating) firstIssues.add('error', 'category', 'required');
  } else {
    const byName = env.categoriesByName.get(looseName(text.category)) ?? [];
    const bySlug = env.categoriesBySlug.get(text.category.toLowerCase());
    const found = byName.length > 0 ? byName : bySlug === undefined ? [] : [bySlug];
    if (found.length === 0) firstIssues.add('error', 'category', 'category.unknown', text.category);
    else if (found.length > 1) {
      firstIssues.add('error', 'category', 'category.ambiguous', text.category);
    } else categoryId = found[0]!;
  }

  // Tax category: the Market's default with a warning on a create; an update leaves the value.
  let taxCategoryCode: string | null = null;
  if (text.taxCategory === '') {
    if (creating) {
      taxCategoryCode = env.taxCategoryCodes[0] ?? null;
      if (taxCategoryCode !== null) {
        firstIssues.add('warning', 'taxCategory', 'tax-category.default-used', taxCategoryCode);
      }
    }
  } else {
    const match = env.taxCategoryCodes.find((code) => looseName(code) === looseName(text.taxCategory));
    if (match === undefined) {
      firstIssues.add('error', 'taxCategory', 'tax-category.unknown', text.taxCategory);
    } else taxCategoryCode = match;
  }

  // Offer cells.
  let conditionCode: string | null = null;
  if (text.condition === '') {
    if (creating) firstIssues.add('error', 'condition', 'required');
  } else {
    conditionCode = env.conditions.find((code) => looseName(code) === looseName(text.condition)) ?? null;
    if (conditionCode === null) {
      firstIssues.add('error', 'condition', 'condition.unknown', text.condition);
    }
  }
  if (text.offerDescription.length > MAX_DESCRIPTION_CHARS) {
    firstIssues.add('error', 'offerDescription', 'too-long', text.offerDescription);
  }

  // Attributes: the cells the file gave, converted by the field's type, then the type handler's check.
  const attributeValues: Record<string, unknown> = {};
  const put = (code: string, cell: string, column: string, warn: boolean): void => {
    if (cell === '') return;
    const field = fieldOf(env, code);
    if (field === undefined || (field.isVariantOption && field.dataType === 'select')) {
      if (warn) firstIssues.add('warning', column, 'column.not-stored', cell);
      return;
    }
    const value = attributeValueOf(field, cell, env.defaultLocale);
    if (!value.ok) firstIssues.add('error', column, value.code, cell);
    else attributeValues[code] = value.value;
  };
  for (const [code, cell] of Object.entries(first.attributes)) {
    put(code, cell, `attribute[${code}]`, false);
  }
  put('brand', text.brand, 'brand', true);
  put('description', text.description, 'description', false);
  if (handler !== undefined && typeCode !== null && !firstIssues.hasError) {
    const validated = handler.validateAttributes(
      env.schema,
      attributeValues as AttributeValues,
      env.locales,
    );
    if (!validated.ok) {
      const seen = new Set<string>();
      for (const issue of validated.error) {
        const code = issue.path.split('.')[0] ?? '';
        const column =
          code === 'brand' || code === 'description' ? code : code === '' ? 'row' : `attribute[${code}]`;
        if (issue.code === 'attribute.required') {
          // A draft may lack a required attribute; the submit asks for it. A create says so.
          if (creating && !seen.has(`w:${column}`)) {
            seen.add(`w:${column}`);
            firstIssues.add('warning', column, issue.code);
          }
          continue;
        }
        if (seen.has(column)) continue;
        seen.add(column);
        firstIssues.add('error', column, issue.code, text[column as SellerColumnKey] ?? '');
      }
    }
  }

  // Photos.
  const imageNames = imageNamesOf(text.images, firstIssues);

  // Variants.
  const variants: SellerVariantPlan[] = [];
  let axes: string[] = [];
  const optionFields = new Map<string, AttributeField>();
  for (const code of axisCandidates(env.schema)) {
    const field = fieldOf(env, code);
    if (field !== undefined) optionFields.set(code, field);
  }
  const optionColumns = Object.keys(first.options);
  const single = handler?.variantModel === 'single';
  if (handler !== undefined) {
    if (single) {
      for (const cells of rows) {
        for (const code of optionColumns) {
          if ((cells.options[code] ?? '') !== '') {
            at(cells).add('error', `option[${code}]`, 'import.option-not-allowed', cells.options[code]);
          }
        }
      }
    } else {
      axes = optionColumns.filter((code) => (first.options[code] ?? '') !== '');
      if (axes.length === 0) {
        firstIssues.add('error', 'row', 'import.option-missing');
      } else {
        const chosen = chooseAxes(
          env.schema,
          axes,
          env.maxVariantAttributes,
          existing?.publishedAxes ?? null,
        );
        if (!chosen.ok) {
          const seen = new Set<string>();
          for (const issue of chosen.issues) {
            if (seen.has(issue.code)) continue;
            seen.add(issue.code);
            firstIssues.add('error', 'row', issue.code);
          }
        }
      }
      if (!firstIssues.list.some((issue) => issue.column === 'row' && issue.code.startsWith('variants.'))) {
        for (const cells of rows) {
          for (const code of optionColumns) {
            const cell = cells.options[code] ?? '';
            if (axes.includes(code) && cell === '') {
              at(cells).add('error', `option[${code}]`, 'import.option-missing');
            } else if (!axes.includes(code) && cell !== '') {
              at(cells).add('error', `option[${code}]`, 'import.option-not-allowed', cell);
            }
          }
        }
      }
    }
  }

  // One plan per row: option values, the key, the existing variant, the V4 fields.
  const seenKeys = new Map<string, number>();
  const seenGtins = new Map<string, number>();
  for (const cells of rows) {
    const issues = at(cells);
    const optionValues: Record<string, string> = {};
    const labels: string[] = [];
    if (!single && handler !== undefined) {
      for (const code of axes) {
        const cell = cells.options[code] ?? '';
        const field = optionFields.get(code);
        if (cell === '' || field === undefined) continue;
        const optionCode = optionCodeOf(field, cell, env.defaultLocale);
        if (optionCode === null) {
          issues.add('error', `option[${code}]`, 'import.option-unknown', cell);
        } else {
          optionValues[code] = optionCode;
          labels.push(optionLabelOf(field, optionCode, env.defaultLocale));
        }
      }
    }
    const optionKey = optionKeyOf(optionValues);
    const complete = single || axes.every((code) => optionValues[code] !== undefined);
    if (complete && handler !== undefined) {
      const earlier = seenKeys.get(optionKey);
      if (earlier !== undefined) {
        issues.add('error', 'row', 'import.duplicate-row', '', earlier);
        const earlierIssues = perRow.get(earlier);
        if (
          earlierIssues !== undefined &&
          !earlierIssues.list.some((issue) => issue.code === 'import.duplicate-row')
        ) {
          earlierIssues.add('error', 'row', 'import.duplicate-row', '', cells.rowNumber);
        }
      } else seenKeys.set(optionKey, cells.rowNumber);
    }

    let gtin: string | null = null;
    if (cells.text.gtin !== '') {
      const normalised = normalizeGtin(cells.text.gtin);
      if (!normalised.ok) issues.add('error', 'gtin', 'gtin.invalid', cells.text.gtin);
      else {
        gtin = normalised.value;
        const earlier = seenGtins.get(gtin);
        if (earlier !== undefined) issues.add('error', 'gtin', 'gtin.duplicate', cells.text.gtin, earlier);
        else seenGtins.set(gtin, cells.rowNumber);
      }
    }
    const size = (key: 'weight' | 'length' | 'width' | 'height', max: number): number | null => {
      const cell = cells.text[key];
      if (cell === '') return null;
      const value = Number(cell);
      if (/^\d+$/.test(cell) && isPositiveInt(value, max)) return value;
      issues.add('error', key, 'invalid', cell);
      return null;
    };
    const weight = size('weight', VARIANT_FIELD_LIMITS.weightGramsMax);
    const length = size('length', VARIANT_FIELD_LIMITS.dimensionMmMax);
    const width = size('width', VARIANT_FIELD_LIMITS.dimensionMmMax);
    const height = size('height', VARIANT_FIELD_LIMITS.dimensionMmMax);
    // A box has three sides: all three or none, so a carrier never reads a half-set size.
    const given = [length, width, height].filter((value) => value !== null).length;
    if (given > 0 && given < 3 && !issues.hasError) {
      for (const [key, value] of [
        ['length', length],
        ['width', width],
        ['height', height],
      ] as const) {
        if (value === null) issues.add('error', key, 'required');
      }
    }

    const match =
      existing === null
        ? null
        : single
          ? (existing.variants[0] ?? null)
          : (existing.variants.find((variant) => variant.optionKey === optionKey) ?? null);
    variants.push({
      rowNumber: cells.rowNumber,
      optionValues,
      optionKey,
      existingVariantId: match?.variantId ?? null,
      gtin,
      shippingWeightGrams: weight,
      shippingLengthMm: length,
      shippingWidthMm: width,
      shippingHeightMm: height,
    });
    summaries.set(
      cells.rowNumber,
      summaryOf(
        cells,
        typeCode ?? text.type,
        labels.join(' / '),
        cells === first ? imageNames : [],
      ),
    );
  }

  // The most variants a product may hold, counting the existing ones on an update.
  if (!single && handler !== undefined) {
    const known = new Set(existing?.variants.map((variant) => variant.optionKey) ?? []);
    const added = variants.filter((variant) => variant.existingVariantId === null).length;
    if (known.size + added > env.maxVariantsPerProduct) {
      firstIssues.add('error', 'row', 'variant.limit-reached', String(env.maxVariantsPerProduct));
    }
  }

  const plan: SellerGroupPlan | null =
    typeCode === null
      ? null
      : {
          mode: 'my-products',
          kind,
          groupRow: group.groupRow,
          sellerSku: sku,
          conditionCode,
          offerDescription: text.offerDescription === '' ? null : text.offerDescription,
          existing,
          catalogueProduct: null,
          product: {
            typeCode,
            title: text.title === '' ? null : text.title,
            shortDescription: text.shortDescription === '' ? null : text.shortDescription,
            description: text.description === '' ? null : text.description,
            categoryId,
            taxCategoryCode,
            attributeValues,
            imageNames,
            axes,
          },
          variants,
        };
  return finish(group, { perRow, summaries, plan });
}

/**
 * Checks one row of a `sell-from-catalogue` file (an Offer on a PLATFORM product, OFR-03). The
 * product code is read like the catalogue search reads it: a code that is not a published, unpaused
 * PLATFORM product is the one answer `product.not-found`, whatever it is (a seller product, a
 * retired one, another Market's, unknown): the answer says nothing that tells them apart.
 */
export function checkCatalogueRow(
  group: SellerGroupRows,
  env: SellerCheckEnvironment,
  facts: SellerCheckFacts,
): CheckedSellerGroup {
  const cells = group.rows[0]!;
  const issues = new Issues();
  const perRow = new Map([[cells.rowNumber, issues]]);
  const text = cells.text;
  if (cells.unstorable) issues.add('error', 'row', 'text.invalid-characters');
  const sku = text.sku;
  let existing: ExistingOfferFact | null = null;
  if (sku === '') issues.add('error', 'sku', 'required');
  else if (!SKU_PATTERN.test(sku)) issues.add('error', 'sku', 'sku.invalid', sku);
  else existing = facts.offersBySku.get(sku) ?? null;

  let product: CatalogueProductFact | null = null;
  if (text.productCode === '') issues.add('error', 'productCode', 'required');
  else {
    product = facts.catalogueByCode.get(text.productCode) ?? null;
    if (product === null) issues.add('error', 'productCode', 'product.not-found');
  }
  if (
    product !== null &&
    env.allowedTypes !== 'all' &&
    !env.allowedTypes.has(product.typeCode)
  ) {
    issues.add('error', 'productCode', 'type.not-allowed');
  }
  let kind: 'create' | 'update' = 'create';
  if (product !== null && existing !== null) {
    if (existing.productId === product.productId) kind = 'update';
    else issues.add('error', 'sku', 'import.key-conflict', sku);
  } else if (product !== null && existing === null) {
    if (facts.ownSkuByProductId.has(product.productId)) {
      issues.add('error', 'productCode', 'offer.exists-for-product');
    }
  }
  const creating = existing === null;

  let conditionCode: string | null = null;
  if (text.condition === '') {
    if (creating) issues.add('error', 'condition', 'required');
  } else {
    conditionCode = env.conditions.find((code) => looseName(code) === looseName(text.condition)) ?? null;
    if (conditionCode === null) issues.add('error', 'condition', 'condition.unknown', text.condition);
  }
  if (text.offerDescription.length > MAX_DESCRIPTION_CHARS) {
    issues.add('error', 'offerDescription', 'too-long', text.offerDescription);
  }
  const plan: SellerGroupPlan = {
    mode: 'sell-from-catalogue',
    kind,
    groupRow: group.groupRow,
    sellerSku: sku,
    conditionCode,
    offerDescription: text.offerDescription === '' ? null : text.offerDescription,
    existing,
    catalogueProduct: product,
    product: null,
    variants: [],
  };
  return finish(group, {
    perRow,
    summaries: new Map([[cells.rowNumber, summaryOf(cells, product?.typeCode ?? '', '', [])]]),
    plan,
  });
}

/** Checks one group, whatever the mode. */
export function checkSellerGroup(
  group: SellerGroupRows,
  map: SellerColumnMap,
  env: SellerCheckEnvironment,
  facts: SellerCheckFacts,
): CheckedSellerGroup {
  return map.mode === 'my-products'
    ? checkProductGroup(group, env, facts)
    : checkCatalogueRow(group, env, facts);
}

/**
 * Checks a whole file: every group, and (for `sell-from-catalogue`) the repeats across rows: the
 * later row of a SKU or a product code that an earlier ready row already has is an error that names
 * the first.
 */
export function checkSellerFile(
  rows: readonly ParsedRow[],
  map: SellerColumnMap,
  env: SellerCheckEnvironment,
  facts: SellerCheckFacts,
): CheckedSellerGroup[] {
  const groups = groupSellerRows(rows, map).map((group) => checkSellerGroup(group, map, env, facts));
  if (map.mode !== 'sell-from-catalogue') return groups;
  const bySku = new Map<string, number>();
  const byProduct = new Map<string, number>();
  return groups.map((checked) => {
    const row = checked.rows[0]!;
    const plan = checked.plan;
    if (plan === null) return checked;
    const earlierSku = bySku.get(plan.sellerSku);
    const productKey = plan.catalogueProduct?.productId ?? '';
    const earlierProduct = byProduct.get(productKey);
    const earlier = earlierSku ?? earlierProduct;
    if (earlier !== undefined) {
      const column = earlierSku !== undefined ? 'sku' : 'productCode';
      const issue: SellerRowIssue = {
        severity: 'error',
        column,
        code: 'duplicate-in-file',
        value: displayValue(column === 'sku' ? plan.sellerSku : row.summary.productCode),
        otherRow: earlier,
      };
      return {
        groupRow: checked.groupRow,
        plan: null,
        rows: [
          {
            ...row,
            state: 'error' as const,
            plan: null,
            issues: boundedIssues([...row.issues, issue]),
          },
        ],
      };
    }
    bySku.set(plan.sellerSku, row.rowNumber);
    byProduct.set(productKey, row.rowNumber);
    return checked;
  });
}

/** The counts of a check: what the tiles show. A row with only warnings is ready. */
export function countSellerRows(groups: readonly CheckedSellerGroup[]): {
  readonly rows: number;
  readonly ready: number;
  readonly errors: number;
  readonly warnings: number;
  readonly groups: number;
} {
  let rows = 0;
  let ready = 0;
  let errors = 0;
  let warnings = 0;
  for (const group of groups) {
    for (const row of group.rows) {
      rows += 1;
      if (row.state === 'ready') ready += 1;
      else errors += 1;
      if (row.issues.some((issue) => issue.severity === 'warning')) warnings += 1;
    }
  }
  return { rows, ready, errors, warnings, groups: groups.length };
}

/** The header the report and the page show for a column token of an issue. */
export function issueHeaderOf(column: string): string {
  if (column === 'row') return 'Row';
  if (column.startsWith('option[') || column.startsWith('attribute[')) {
    const open = column.indexOf('[');
    const kind = column.slice(0, open) === 'option' ? 'Option' : 'Attribute';
    return `${kind}${column.slice(open)}`;
  }
  return headerOfKey(column as SellerColumnKey);
}
