import {
  CERTIFICATION_HEADER,
  displayHeader,
  normaliseHeader,
} from '../platform-import/columns';
import type { ParsedTable } from '../platform-import/import-file';

// The columns of the seller import file (catalog design 14c). Headers are matched as the platform
// import matches them (`normaliseHeader`: case, spaces, `_` and `-` do not matter), plus the bracket
// columns `Option[<code>]` and `Attribute[<code>]`. A header that is not read is listed as ignored
// with a mark: `certification` (never imported: CERT rules, OFR-12) or `elsewhere` (price, cost and
// stock are not read in this build, ADR-0024 d5). Such a column's cells are never read.

/** The two modes of a file, chosen at the check and kept on the job (design 14c, "Modes"). */
export const SELLER_IMPORT_MODES = ['my-products', 'sell-from-catalogue'] as const;
export type SellerImportMode = (typeof SELLER_IMPORT_MODES)[number];

export const SELLER_COLUMN_KEYS = [
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
] as const;
export type SellerColumnKey = (typeof SELLER_COLUMN_KEYS)[number];

interface SellerColumn {
  readonly key: SellerColumnKey;
  /** The header of the template. */
  readonly header: string;
  /** Other headers that mean the same column, compared after {@link normaliseHeader}. */
  readonly aliases: readonly string[];
  /** The modes that read this column; in the other mode it is listed as ignored. */
  readonly modes: readonly SellerImportMode[];
  /** The modes in which a file without this column is refused (`columns.missing`). */
  readonly requiredIn: readonly SellerImportMode[];
}

const BOTH = SELLER_IMPORT_MODES;
const MINE = ['my-products'] as const;
const CATALOGUE = ['sell-from-catalogue'] as const;

export const SELLER_COLUMNS: readonly SellerColumn[] = Object.freeze([
  { key: 'sku', header: 'Seller SKU', aliases: ['sku'], modes: BOTH, requiredIn: BOTH },
  { key: 'condition', header: 'Condition', aliases: [], modes: BOTH, requiredIn: [] },
  { key: 'offerDescription', header: 'Offer description', aliases: [], modes: BOTH, requiredIn: [] },
  {
    key: 'productCode',
    header: 'Product code',
    aliases: [],
    modes: CATALOGUE,
    requiredIn: CATALOGUE,
  },
  {
    key: 'title',
    header: 'Title',
    aliases: ['name', 'product name'],
    modes: MINE,
    requiredIn: MINE,
  },
  {
    key: 'category',
    header: 'Main category',
    aliases: ['category'],
    modes: MINE,
    requiredIn: MINE,
  },
  { key: 'type', header: 'Product type', aliases: ['type'], modes: MINE, requiredIn: MINE },
  { key: 'shortDescription', header: 'Short description', aliases: [], modes: MINE, requiredIn: [] },
  { key: 'description', header: 'Description', aliases: [], modes: MINE, requiredIn: [] },
  { key: 'brand', header: 'Brand', aliases: [], modes: MINE, requiredIn: [] },
  { key: 'taxCategory', header: 'Tax category', aliases: ['tax'], modes: MINE, requiredIn: [] },
  {
    key: 'images',
    header: 'Images',
    aliases: ['image', 'photos', 'photo'],
    modes: MINE,
    requiredIn: [],
  },
  {
    key: 'gtin',
    header: 'Barcode (GTIN)',
    aliases: ['barcode', 'gtin'],
    modes: MINE,
    requiredIn: [],
  },
  { key: 'weight', header: 'Weight (g)', aliases: ['weight'], modes: MINE, requiredIn: [] },
  { key: 'length', header: 'Length (mm)', aliases: ['length'], modes: MINE, requiredIn: [] },
  { key: 'width', header: 'Width (mm)', aliases: ['width'], modes: MINE, requiredIn: [] },
  { key: 'height', header: 'Height (mm)', aliases: ['height'], modes: MINE, requiredIn: [] },
]);

/** The header of a column as the template shows it. */
export function headerOfKey(key: SellerColumnKey): string {
  return SELLER_COLUMNS.find((column) => column.key === key)?.header ?? key;
}

/**
 * Headers that would set a price, a cost, a stock level or a quantity (design 14c, "Price, stock and
 * Cost"): not read in this build. `catalog` has no price or stock and its events and responses carry
 * none, so such a cell has nowhere to go; the seller sets them in Prices and Stock.
 */
export const PRICE_STOCK_HEADER = /price|cost|special|stock|qty|quantity|inventor/;

/** The mark of an ignored column. */
export type IgnoredMark = 'certification' | 'elsewhere' | null;

export interface SellerIgnoredColumn {
  /** The header as sent, with control characters removed and cut to 60 characters. */
  readonly header: string;
  readonly mark: IgnoredMark;
}

/** What a header looks like, by its normalised text: certification first (the stricter rule). */
export function markOf(normalisedHeader: string): IgnoredMark {
  if (CERTIFICATION_HEADER.test(normalisedHeader)) return 'certification';
  if (PRICE_STOCK_HEADER.test(normalisedHeader)) return 'elsewhere';
  return null;
}

export interface BracketColumn {
  readonly code: string;
  readonly index: number;
}

export interface SellerColumnMap {
  readonly mode: SellerImportMode;
  readonly fixed: Readonly<Partial<Record<SellerColumnKey, number>>>;
  /** `Option[<code>]`: one per axis candidate of the Market's family. */
  readonly options: readonly BracketColumn[];
  /** `Attribute[<code>]`: the non-option attributes of the family. */
  readonly attributes: readonly BracketColumn[];
  readonly ignored: readonly SellerIgnoredColumn[];
}

export type SellerColumnsRefusal =
  | { readonly code: 'columns.missing'; readonly columns: readonly string[] }
  | { readonly code: 'columns.duplicate'; readonly columns: readonly string[] };

/** The codes a bracket column may name: read from the Market's default family, never from the file. */
export interface KnownBracketCodes {
  readonly optionCodes: ReadonlySet<string>;
  readonly attributeCodes: ReadonlySet<string>;
}

const BRACKET = /^(option|attribute)\s*\[\s*([^\]]*?)\s*\]$/;

/**
 * Reads the header row of the seller file: which file column is which known column, and which are
 * ignored (with their marks). A required column that is missing, or a known column that appears
 * twice, refuses the file. An unknown code in `Option[...]` or `Attribute[...]` is an ignored column,
 * never a new attribute; a bracket column whose text looks like certification or price is ignored
 * even when a family field of that code exists.
 */
export function mapSellerColumns(
  header: ParsedTable['header'],
  mode: SellerImportMode,
  known: KnownBracketCodes,
):
  | { readonly ok: true; readonly value: SellerColumnMap }
  | { readonly ok: false; readonly error: SellerColumnsRefusal } {
  const fixed: Partial<Record<SellerColumnKey, number>> = {};
  const options: BracketColumn[] = [];
  const attributes: BracketColumn[] = [];
  const ignored: SellerIgnoredColumn[] = [];
  const duplicated = new Set<string>();
  const seenBrackets = new Set<string>();
  header.forEach((raw, index) => {
    const name = normaliseHeader(raw);
    if (name === '') return;
    const ignore = (): void => {
      ignored.push({ header: displayHeader(raw), mark: markOf(name) });
    };
    const bracket = BRACKET.exec(raw.normalize('NFKC').trim().toLowerCase());
    if (bracket !== null) {
      const kind = bracket[1] as 'option' | 'attribute';
      const code = bracket[2] ?? '';
      const inSet = kind === 'option' ? known.optionCodes : known.attributeCodes;
      if (mode !== 'my-products' || code === '' || !inSet.has(code) || markOf(normaliseHeader(code)) !== null) {
        ignore();
        return;
      }
      const id = `${kind}[${code}]`;
      if (seenBrackets.has(id)) duplicated.add(id);
      else {
        seenBrackets.add(id);
        (kind === 'option' ? options : attributes).push({ code, index });
      }
      return;
    }
    const column = SELLER_COLUMNS.find(
      (candidate) =>
        normaliseHeader(candidate.header) === name || candidate.aliases.includes(name),
    );
    if (column === undefined || !column.modes.includes(mode)) {
      ignore();
      return;
    }
    if (fixed[column.key] !== undefined) duplicated.add(column.key);
    else fixed[column.key] = index;
  });
  if (duplicated.size > 0) {
    return { ok: false, error: { code: 'columns.duplicate', columns: [...duplicated] } };
  }
  const missing = SELLER_COLUMNS.filter(
    (column) => column.requiredIn.includes(mode) && fixed[column.key] === undefined,
  );
  if (missing.length > 0) {
    return {
      ok: false,
      error: { code: 'columns.missing', columns: missing.map((column) => column.key) },
    };
  }
  return { ok: true, value: { mode, fixed, options, attributes, ignored } };
}
