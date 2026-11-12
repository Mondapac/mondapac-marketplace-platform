import type { ParsedTable } from './import-file';
import { replaceControlCharacters } from './text-safety';

/** The columns of the platform product file (catalog design 14a). The key is stable; the header is what the file shows. */
export const IMPORT_COLUMN_KEYS = [
  'title',
  'category',
  'type',
  'description',
  'brand',
  'gtin',
  'unitSize',
  'imageUrl',
  'taxCategory',
] as const;
export type ImportColumnKey = (typeof IMPORT_COLUMN_KEYS)[number];

export interface ImportColumn {
  readonly key: ImportColumnKey;
  /** The header of the template. */
  readonly header: string;
  readonly required: boolean;
  /** Other headers that mean the same column, compared after {@link normaliseHeader}. */
  readonly aliases: readonly string[];
}

export const IMPORT_COLUMNS: readonly ImportColumn[] = Object.freeze([
  { key: 'title', header: 'Title', required: true, aliases: ['name', 'product name'] },
  { key: 'category', header: 'Main category', required: true, aliases: ['category'] },
  { key: 'type', header: 'Product type', required: true, aliases: ['type'] },
  { key: 'description', header: 'Description', required: false, aliases: [] },
  { key: 'brand', header: 'Brand', required: false, aliases: [] },
  { key: 'gtin', header: 'Barcode (GTIN)', required: false, aliases: ['barcode', 'gtin'] },
  { key: 'unitSize', header: 'Unit size', required: false, aliases: ['unit'] },
  { key: 'imageUrl', header: 'Image URL', required: false, aliases: ['image'] },
  { key: 'taxCategory', header: 'Tax category', required: false, aliases: ['tax'] },
]);

/** A header compared loosely: case, spacing, `_` and `-` do not matter. */
export function normaliseHeader(header: string): string {
  return header
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[_\-\s]+/g, ' ')
    .trim();
}

/**
 * Headers that would set what the import must never set: a certification, a handling or
 * attestation, a badge, a decision or a status (design 14 "Refused columns", CERT rules: product
 * content never asserts a certification; Import never writes handling, attestation or tags). Such
 * a column is not read; the check lists it so the admin knows it did nothing.
 */
export const CERTIFICATION_HEADER =
  /halal|kosher|vegan|certif|attest|handling|\btags?\b|badge|approv|basis|provenance|publish|\bstatus\b/;

export interface IgnoredColumn {
  /** The header as sent, with control characters removed and cut to 60 characters. */
  readonly header: string;
  /** True for a header that looks like a certification, handling or status column. */
  readonly certification: boolean;
}

/** A header made safe to echo: no control character, at most 60 characters. */
export function displayHeader(header: string): string {
  return replaceControlCharacters(header).trim().slice(0, 60);
}

export type ColumnMap = Readonly<Partial<Record<ImportColumnKey, number>>>;

export type ColumnsRefusal =
  | { readonly code: 'columns.missing'; readonly columns: readonly ImportColumnKey[] }
  | { readonly code: 'columns.duplicate'; readonly columns: readonly string[] };

/** The column of one attribute: `attr[<code>]` (attributes package A9), the code of the attribute. */
export type AttributeColumn = `attr[${string}]`;
export const attributeColumn = (code: string): AttributeColumn => `attr[${code}]`;

/** Attribute code to the index of its column in the file. */
export type AttributeColumnMap = ReadonlyMap<string, number>;

export interface MappedColumns {
  readonly map: ColumnMap;
  /** The `attr[<code>]` columns of the file. */
  readonly attributes: AttributeColumnMap;
  readonly ignored: readonly IgnoredColumn[];
}

/** The most attribute columns one file may carry. */
export const ATTRIBUTE_COLUMNS_MAX = 40;
const ATTRIBUTE_HEADER = /^attr\s*\[\s*([a-z][a-z0-9_-]{0,63})\s*\]$/;

/**
 * The attribute code of an `attr[<code>]` header (case and spacing do not matter), or null.
 * A code that looks like a certification, handling or status column is never an attribute column:
 * the import never writes those (see {@link CERTIFICATION_HEADER}); the header is then ignored.
 */
export function attributeCodeOf(header: string): string | null {
  const match = ATTRIBUTE_HEADER.exec(header.normalize('NFKC').trim().toLowerCase());
  const code = match?.[1];
  // `_` counts as a letter to `\b`, so the guard also reads the code with `-` for `_`.
  if (code === undefined || CERTIFICATION_HEADER.test(code.replaceAll('_', '-'))) return null;
  return code;
}

/**
 * Reads the header row: which file column is which known column, and which columns are ignored.
 * A required column that is missing, or a known column that appears twice, refuses the file.
 */
export function mapColumns(
  header: ParsedTable['header'],
):
  | { readonly ok: true; readonly value: MappedColumns }
  | { readonly ok: false; readonly error: ColumnsRefusal } {
  const map: Partial<Record<ImportColumnKey, number>> = {};
  const duplicated = new Set<string>();
  const attributes = new Map<string, number>();
  const ignored: IgnoredColumn[] = [];
  header.forEach((raw, index) => {
    const attributeCode = attributeCodeOf(raw);
    if (attributeCode !== null) {
      if (attributes.has(attributeCode)) duplicated.add(attributeColumn(attributeCode));
      else if (attributes.size < ATTRIBUTE_COLUMNS_MAX) attributes.set(attributeCode, index);
      else ignored.push({ header: displayHeader(raw), certification: false });
      return;
    }
    const name = normaliseHeader(raw);
    const column = IMPORT_COLUMNS.find(
      (candidate) => normaliseHeader(candidate.header) === name || candidate.aliases.includes(name),
    );
    if (column === undefined) {
      if (name !== '') {
        ignored.push({
          header: displayHeader(raw),
          certification: CERTIFICATION_HEADER.test(name),
        });
      }
      return;
    }
    if (map[column.key] !== undefined) duplicated.add(column.key);
    else map[column.key] = index;
  });
  if (duplicated.size > 0) {
    return { ok: false, error: { code: 'columns.duplicate', columns: [...duplicated] } };
  }
  const missing = IMPORT_COLUMNS.filter(
    (column) => column.required && map[column.key] === undefined,
  );
  if (missing.length > 0) {
    return {
      ok: false,
      error: { code: 'columns.missing', columns: missing.map((column) => column.key) },
    };
  }
  return { ok: true, value: { map, attributes, ignored } };
}

/** The template: the header row and one example row, so a spreadsheet opens it ready to fill. */
export function templateRows(
  typeExample: string,
  attributeCodes: readonly string[] = [],
): readonly (readonly string[])[] {
  return [
    [...IMPORT_COLUMNS.map((column) => column.header), ...attributeCodes.map(attributeColumn)],
    [
      'Lamb shoulder 1 kg',
      'Meat',
      typeExample,
      'Bone-in lamb shoulder',
      'Example Farms',
      '',
      '1 kg',
      '',
      '',
      ...attributeCodes.map(() => ''),
    ],
  ];
}
