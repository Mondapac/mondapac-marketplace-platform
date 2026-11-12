import type { LocalizedText } from '../../domain/attribute-definition';
import { replaceControlCharacters } from '../../domain/platform-import/text-safety';

// The columns of the attribute files (attributes package A9): shared by the export, which writes
// them, and the import, which reads them back. The two files are `attributes` (one row per
// attribute) and `values` (one row per value of a select attribute). The header is English; the
// language columns are `name[<locale>]`, `help[<locale>]` and `label[<locale>]`, one per locale of
// the Market, the default locale first.

export const ATTRIBUTE_FILE_KINDS = ['attributes', 'values'] as const;
export type AttributeFileKind = (typeof ATTRIBUTE_FILE_KINDS)[number];

/** The cells before the language columns of the attributes file. */
export const ATTRIBUTE_HEAD = [
  'code',
  'type',
  'localizable',
  'status',
  'material',
  'variant_option',
  'show_on_product_page',
  'searchable',
  'can_be_filter',
  'position',
  'max_length',
  'min',
  'max',
  'measure_dimension',
  'measure_units',
  'measure_default_unit',
  'measure_decimals',
] as const;
export type AttributeHeadColumn = (typeof ATTRIBUTE_HEAD)[number];

/** Columns the export adds and the import never reads: they are computed. */
export const ATTRIBUTE_TAIL = ['products', 'missing'] as const;

export const VALUE_HEAD = ['attribute_code', 'value_code', 'active', 'position'] as const;
export type ValueHeadColumn = (typeof VALUE_HEAD)[number];

export const LANGUAGE_PREFIXES = {
  attributes: ['name', 'help'],
  values: ['label'],
} as const satisfies Record<AttributeFileKind, readonly string[]>;

/** `name[en-AU]`. */
export const languageHeader = (prefix: string, locale: string): string => `${prefix}[${locale}]`;

/** The header row of a file, for the Market's locales (the default first). */
export function headerOf(kind: AttributeFileKind, locales: readonly string[]): string[] {
  return kind === 'attributes'
    ? [
        ...ATTRIBUTE_HEAD,
        ...locales.map((l) => languageHeader('name', l)),
        ...locales.map((l) => languageHeader('help', l)),
        ...ATTRIBUTE_TAIL,
      ]
    : [...VALUE_HEAD, ...locales.map((l) => languageHeader('label', l)), ...ATTRIBUTE_TAIL];
}

/** A header compared loosely: case and spacing do not matter; `-` inside a locale does. */
const LANGUAGE_HEADER = /^([a-z]+)\s*\[\s*([A-Za-z0-9-]+)\s*\]$/;

export function normaliseColumn(header: string): string {
  return header
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

export interface FileColumns {
  readonly kind: AttributeFileKind;
  /** Head column to the index in the file. */
  readonly head: ReadonlyMap<string, number>;
  /** Prefix (`name`, `help`, `label`) to locale to the index in the file. */
  readonly languages: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Headers that were not read, as sent, cut to 60 characters. */
  readonly ignored: readonly string[];
}

export type ColumnsRefusal =
  | { readonly code: 'columns.kind-unknown' }
  | { readonly code: 'columns.missing'; readonly columns: readonly string[] }
  | { readonly code: 'columns.duplicate'; readonly columns: readonly string[] };

// Control characters out, so a hostile header never reaches a log or a response as sent.
const clean = (text: string): string => replaceControlCharacters(text).trim().slice(0, 60);

/**
 * Reads the header row: which kind of file it is (`code` + `type` is the attributes file,
 * `attribute_code` + `value_code` the values file), which columns are known, and which are ignored.
 * A language column names a locale of the Market (matched without regard to case) or it is ignored.
 * A column that appears twice, or a required one that is missing, refuses the file.
 */
export function readColumns(
  header: readonly string[],
  locales: readonly string[],
):
  | { readonly ok: true; readonly value: FileColumns }
  | { readonly ok: false; readonly error: ColumnsRefusal } {
  const names = header.map(normaliseColumn);
  const kind: AttributeFileKind | null =
    names.includes('attribute_code') && names.includes('value_code')
      ? 'values'
      : names.includes('code') && names.includes('type')
        ? 'attributes'
        : null;
  if (kind === null) return { ok: false, error: { code: 'columns.kind-unknown' } };
  const known: readonly string[] = kind === 'attributes' ? ATTRIBUTE_HEAD : VALUE_HEAD;
  const prefixes: readonly string[] = LANGUAGE_PREFIXES[kind];
  const head = new Map<string, number>();
  const languages = new Map<string, Map<string, number>>();
  const duplicated = new Set<string>();
  const ignored: string[] = [];
  header.forEach((raw, index) => {
    const name = names[index]!;
    if (name === '') return;
    if (known.includes(name)) {
      if (head.has(name)) duplicated.add(name);
      else head.set(name, index);
      return;
    }
    const match = LANGUAGE_HEADER.exec(raw.normalize('NFKC').trim().toLowerCase());
    if (match !== null && prefixes.includes(match[1]!)) {
      const locale = locales.find((l) => l.toLowerCase() === match[2]);
      if (locale !== undefined) {
        const byLocale = languages.get(match[1]!) ?? new Map<string, number>();
        if (byLocale.has(locale)) duplicated.add(`${match[1]}[${locale}]`);
        else byLocale.set(locale, index);
        languages.set(match[1]!, byLocale);
        return;
      }
    }
    // The computed columns are not read and not worth a warning.
    if ((ATTRIBUTE_TAIL as readonly string[]).includes(name)) return;
    ignored.push(clean(raw));
  });
  if (duplicated.size > 0) {
    return { ok: false, error: { code: 'columns.duplicate', columns: [...duplicated].sort() } };
  }
  const required = kind === 'attributes' ? ['code', 'type'] : ['attribute_code', 'value_code'];
  const missing = required.filter((column) => !head.has(column));
  if (missing.length > 0) {
    return { ok: false, error: { code: 'columns.missing', columns: missing } };
  }
  return { ok: true, value: { kind, head, languages, ignored } };
}

/** Whether a text has content (not blank). */
export const filled = (text: string | undefined): text is string =>
  text !== undefined && text.trim() !== '';

/** The text of one language in a record, or the empty string. */
export const textOf = (texts: LocalizedText, locale: string): string => texts[locale] ?? '';

/** `yes` or `no`, the way the export writes a flag. */
export const yesNo = (value: boolean): string => (value ? 'yes' : 'no');

/** A flag from a cell: yes/no, true/false, 1/0; null when the cell is not one of them. */
export function flagOf(text: string): boolean | null {
  switch (text.trim().toLowerCase()) {
    case 'yes':
    case 'true':
    case '1':
      return true;
    case 'no':
    case 'false':
    case '0':
      return false;
    default:
      return null;
  }
}

/** A finite number from a cell (a plain decimal, no exponent, no separators), or null. */
export function numberOf(text: string): number | null {
  const trimmed = text.trim();
  if (!/^-?\d{1,15}(\.\d{1,9})?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}
