import {
  CSV_BOM,
  csvLine,
  looksLikeText,
  parseCsvBytes,
  unguardCell,
} from '@mondapac/platform-import';
import { inputOf, minorOf } from '../price/money.ts';

// The variant file of one Offer (catalog design 14b): the CSV the seller exports from the offer's
// Variants tab and the update-only import of it, all in the browser. The file never goes to the
// server; a changed cell becomes a draft of the tab and is saved through the price and stock
// routes by the tab's own Save. Pure functions: no I/O, no React.
//
// `variant_sku` and `selling` are the sell-unit columns of V5 (`own-offer.set-sell-units`): the
// seller's SKU of one variant and its on-sale switch. A SKU the file names is also a key (rule (c)).

/** The limits of a variant file (design 14b); the row cap is the Market's `maxVariantsPerProduct`. */
export const FILE_LIMITS = Object.freeze({ bytes: 1024 * 1024, columns: 64, cellChars: 10_000 });

const MAX_ON_HAND = 1_000_000;
const WHOLE = /^\d{1,7}$/;

export interface FileAxis {
  readonly code: string;
  readonly options: readonly { readonly code: string; readonly label: string }[];
}

export interface FileVariant {
  readonly variantId: string;
  readonly variantCode: string;
  /** `published` variants are the live ones; `retired` and `proposed` are never updated. */
  readonly state: 'published' | 'retired' | 'proposed';
  /** Option code per axis code. */
  readonly options: Readonly<Record<string, string>>;
  readonly gtin: string;
  /** The seller's SKU of this sell unit; empty when it has none. */
  readonly variantSku: string;
  /** The sell unit is on sale (no stored row means it is). */
  readonly selling: boolean;
  /** The regular price in force, in minor units; null when there is none or it is not visible. */
  readonly price: string | null;
  /** The level and its version per stock location id. */
  readonly stock: Readonly<Record<string, { readonly onHand: number } | undefined>>;
}

/** Everything the file needs to know about the Offer's product, as the tab read it. */
export interface FileModel {
  readonly productCode: string;
  readonly currency: string;
  readonly axes: readonly FileAxis[];
  readonly variants: readonly FileVariant[];
  readonly sources: readonly { readonly id: string; readonly name: string }[];
  /** The seller may see prices / stock levels (the columns exist at all). */
  readonly showPrice: boolean;
  readonly showStock: boolean;
  /** The seller may change them (a file that has the column is refused without the key). */
  readonly canEditPrice: boolean;
  readonly canEditStock: boolean;
  /** The seller may change the SKU and the selling switch (the V5 route's key). */
  readonly canEditSellUnits: boolean;
  /** `maxVariantsPerProduct`: the data rows one file may hold. */
  readonly maxRows: number;
}

/** A variant SKU: 1 to 64 printable ASCII characters, no space (the V5 rule). */
export const VARIANT_SKU = /^[\x21-\x7e]{1,64}$/;

const optionHeader = (axis: string) => `option[${axis}]`;
const stockHeader = (sourceId: string) => `stock[${sourceId}]`;
const exportedHeader = (sourceId: string) => `stock_exported[${sourceId}]`;

/** The file the seller exports: one row per live variant, CSV with a byte order mark. */
export function exportVariantFile(model: FileModel): string {
  const live = model.variants
    .filter((variant) => variant.state === 'published')
    .sort((a, b) => a.variantCode.localeCompare(b.variantCode));
  const header = [
    'product_code',
    'variant_code',
    ...model.axes.map((axis) => optionHeader(axis.code)),
    'gtin',
    'variant_sku',
    'selling',
    ...(model.showPrice ? ['price'] : []),
    ...(model.showStock ? model.sources.map((source) => stockHeader(source.id)) : []),
    ...(model.showStock ? model.sources.map((source) => exportedHeader(source.id)) : []),
  ];
  const stockOf = (variant: FileVariant, sourceId: string) =>
    variant.stock[sourceId]?.onHand === undefined ? '' : String(variant.stock[sourceId].onHand);
  const lines = live.map((variant) => [
    model.productCode,
    variant.variantCode,
    ...model.axes.map((axis) => {
      const code = variant.options[axis.code];
      return axis.options.find((option) => option.code === code)?.label ?? code ?? '';
    }),
    variant.gtin,
    variant.variantSku,
    variant.selling ? 'yes' : 'no',
    ...(model.showPrice
      ? [variant.price === null ? '' : inputOf(variant.price, model.currency)]
      : []),
    ...(model.showStock ? model.sources.map((source) => stockOf(variant, source.id)) : []),
    ...(model.showStock ? model.sources.map((source) => stockOf(variant, source.id)) : []),
  ]);
  return CSV_BOM + [header, ...lines].map((cells) => csvLine(cells)).join('');
}

/** Why a file was refused whole, before any row was looked at. Codes only. */
export type FileRefusal =
  | { readonly code: 'file.too-large'; readonly maxBytes: number }
  | { readonly code: 'file.unsupported-type' }
  | { readonly code: 'file.unreadable' }
  | { readonly code: 'file.too-many-columns'; readonly max: number }
  | { readonly code: 'file.cell-too-long'; readonly rowNumber: number; readonly max: number }
  | { readonly code: 'file.no-rows' }
  | { readonly code: 'import.too-many-rows'; readonly max: number }
  | { readonly code: 'import.column-missing'; readonly columns: readonly string[] }
  | { readonly code: 'import.column-refused'; readonly columns: readonly string[] }
  | { readonly code: 'import.column-not-allowed'; readonly columns: readonly string[] };

export type RowCode =
  | 'import.other-product'
  | 'import.variant-not-found'
  | 'import.variant-retired'
  | 'import.key-conflict'
  | 'import.option-missing'
  | 'import.option-unknown'
  | 'import.duplicate-row'
  | 'import.invalid-value'
  | 'import.none-selling'
  | 'import.read-only-column';

export interface RowIssue {
  readonly rowNumber: number;
  readonly code: RowCode;
  /** The column the issue is about, when it is about one. */
  readonly column?: string;
}

/** One cell the import would change: current value to file value. */
export interface CellChange {
  /** `price:<id>`, `stock:<id>:<sourceId>`, `sku:<id>` or `selling:<id>`: the key of a draft. */
  readonly key: string;
  readonly rowNumber: number;
  readonly variantId: string;
  readonly variantCode: string;
  readonly kind: 'price' | 'stock' | 'sku' | 'selling';
  readonly sourceId?: string;
  /** Texts as the tab shows them (price in major units, stock as a count, selling `yes`/`no`). */
  readonly from: string;
  readonly to: string;
  /** `import.stock-changed`: the level moved since the export; the seller confirms or exports again. */
  readonly code?: 'import.stock-changed';
}

export interface ImportPreview {
  readonly changes: readonly CellChange[];
  /** Row errors: the row is not applied. */
  readonly errors: readonly RowIssue[];
  readonly warnings: readonly RowIssue[];
  /** Header cells that are none of the file's columns (ignored). */
  readonly ignoredColumns: readonly string[];
  readonly rowCount: number;
}

export type ImportResult =
  | { readonly ok: true; readonly preview: ImportPreview }
  | { readonly ok: false; readonly refusal: FileRefusal };

/** Case- and space-insensitive comparison key of a label or code. */
export const labelKey = (text: string): string =>
  text.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();

/** Header cells that would set approval, a claim, handling or a status: never read from a file. */
const REFUSED_COLUMN = /certif|handling|attest|status|approv|basis|provenance|claim|badge/iu;

const NO_ISSUES: readonly RowIssue[] = [];

interface Resolved {
  readonly variant: FileVariant;
}

/** Reads a variant file against the Offer's model; update only, nothing is ever created. */
export function readVariantFile(bytes: Uint8Array, model: FileModel): ImportResult {
  if (bytes.length > FILE_LIMITS.bytes) {
    return { ok: false, refusal: { code: 'file.too-large', maxBytes: FILE_LIMITS.bytes } };
  }
  if (bytes.length === 0 || !looksLikeText(bytes)) {
    return { ok: false, refusal: { code: 'file.unsupported-type' } };
  }
  const read = parseCsvBytes(bytes, {
    rows: model.maxRows,
    columns: FILE_LIMITS.columns,
    cellChars: FILE_LIMITS.cellChars,
  });
  if (!read.ok) return { ok: false, refusal: read.error };
  const table = read.value;
  // Row max + 1 is read: the file has more variants than a product may have.
  if (table.rowCount > model.maxRows) {
    return { ok: false, refusal: { code: 'import.too-many-rows', max: model.maxRows } };
  }
  if (table.header.length === 0 || table.rowCount === 0) {
    return { ok: false, refusal: { code: 'file.no-rows' } };
  }

  const header = table.header.map((cell) => unguardCell(cell).trim());
  const at = new Map<string, number>();
  header.forEach((name, index) => {
    if (!at.has(name)) at.set(name, index);
  });
  const axisByColumn = new Map(model.axes.map((axis) => [optionHeader(axis.code), axis]));
  const sourceById = new Map(model.sources.map((source) => [source.id, source]));
  const known = (name: string): boolean =>
    name === 'product_code' ||
    name === 'variant_code' ||
    name === 'gtin' ||
    name === 'variant_sku' ||
    name === 'selling' ||
    name === 'price' ||
    axisByColumn.has(name) ||
    [...sourceById.keys()].some((id) => name === stockHeader(id) || name === exportedHeader(id));

  const refused = header.filter((name) => !known(name) && REFUSED_COLUMN.test(name));
  if (refused.length > 0) {
    return { ok: false, refusal: { code: 'import.column-refused', columns: refused } };
  }
  if (!at.has('product_code')) {
    return { ok: false, refusal: { code: 'import.column-missing', columns: ['product_code'] } };
  }
  const notAllowed = header.filter(
    (name) =>
      (name === 'price' && !model.canEditPrice) ||
      ((name === 'variant_sku' || name === 'selling') && !model.canEditSellUnits) ||
      ([...sourceById.keys()].some((id) => name === stockHeader(id)) && !model.canEditStock),
  );
  if (notAllowed.length > 0) {
    return { ok: false, refusal: { code: 'import.column-not-allowed', columns: notAllowed } };
  }
  const ignoredColumns = header.filter((name) => name !== '' && !known(name));

  const live = model.variants.filter((variant) => variant.state === 'published');
  const byCode = new Map(model.variants.map((variant) => [variant.variantCode, variant]));
  const bySku = new Map(
    live
      .filter((variant) => variant.variantSku !== '')
      .map((variant) => [variant.variantSku, variant]),
  );
  const byCombination = new Map(
    live.map((variant) => [
      JSON.stringify(model.axes.map((axis) => variant.options[axis.code] ?? '')),
      variant,
    ]),
  );

  const cell = (row: readonly string[], name: string): string | undefined => {
    const index = at.get(name);
    return index === undefined ? undefined : unguardCell(row[index] ?? '');
  };

  /** The option code a row's label names on an axis: `null` when it names none. */
  const optionOf = (axis: FileAxis, text: string): string | null => {
    const wanted = labelKey(text);
    return (
      axis.options.find(
        (option) => labelKey(option.label) === wanted || labelKey(option.code) === wanted,
      )?.code ?? null
    );
  };

  const errors: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  const resolved = new Map<number, Resolved>();
  const claimed = new Map<string, number[]>();

  for (const row of table.rows) {
    const fail = (code: RowCode, column?: string) =>
      errors.push({ rowNumber: row.rowNumber, code, ...(column === undefined ? {} : { column }) });
    if ((cell(row.cells, 'product_code') ?? '') !== model.productCode) {
      fail('import.other-product', 'product_code');
      continue;
    }

    // The option labels of the row, when every axis is given and each names an option.
    let named: FileVariant | null | 'partial' = 'partial';
    let optionProblem: RowCode | null = null;
    let failedColumn: string | undefined;
    const chosen: string[] = [];
    for (const axis of model.axes) {
      const column = optionHeader(axis.code);
      const text = cell(row.cells, column);
      if (text === undefined || text.trim() === '') {
        optionProblem ??= 'import.option-missing';
        failedColumn ??= column;
        continue;
      }
      const code = optionOf(axis, text);
      if (code === null) {
        optionProblem = 'import.option-unknown';
        failedColumn = column;
        break;
      }
      chosen.push(code);
    }
    if (model.axes.length > 0 && optionProblem === null) {
      named = byCombination.get(JSON.stringify(chosen)) ?? null;
    }

    const code = (cell(row.cells, 'variant_code') ?? '').trim();
    const fileSku = (cell(row.cells, 'variant_sku') ?? '').trim();
    const skuOwner = fileSku === '' ? undefined : bySku.get(fileSku);
    let variant: FileVariant | undefined;
    if (code !== '') {
      // (b) the variant code is the only key.
      const found = byCode.get(code);
      if (found === undefined || found.state === 'proposed') {
        fail('import.variant-not-found', 'variant_code');
        continue;
      }
      if (found.state === 'retired') {
        fail('import.variant-retired', 'variant_code');
        continue;
      }
      if (
        (named !== 'partial' && named !== null && named.variantId !== found.variantId) ||
        (skuOwner !== undefined && skuOwner.variantId !== found.variantId)
      ) {
        fail('import.key-conflict', 'variant_code');
        continue;
      }
      variant = found;
    } else if (skuOwner !== undefined) {
      // (c) without a variant code, a variant SKU that is some variant's own is the key.
      if (named !== 'partial' && named !== null && named.variantId !== skuOwner.variantId) {
        fail('import.key-conflict', 'variant_sku');
        continue;
      }
      variant = skuOwner;
    } else {
      // (d) the option labels. A SKU that is nobody's is a new value for the variant they name.
      if (optionProblem !== null) {
        fail(optionProblem, failedColumn);
        continue;
      }
      if (model.axes.length === 0 || named === null || named === 'partial') {
        fail('import.variant-not-found');
        continue;
      }
      variant = named;
    }
    resolved.set(row.rowNumber, { variant });
    claimed.set(variant.variantId, [...(claimed.get(variant.variantId) ?? []), row.rowNumber]);
  }

  // (e) two rows that resolve to the same variant both fail.
  for (const rows of claimed.values()) {
    if (rows.length < 2) continue;
    for (const rowNumber of rows) {
      resolved.delete(rowNumber);
      errors.push({ rowNumber, code: 'import.duplicate-row' });
    }
  }

  const changes: CellChange[] = [];
  for (const row of table.rows) {
    const match = resolved.get(row.rowNumber);
    if (match === undefined) continue;
    const { variant } = match;
    const rowErrors: RowIssue[] = [];
    const rowWarnings: RowIssue[] = [];
    const rowChanges: CellChange[] = [];

    // Read-only columns: a different value is a warning, never a change.
    const gtin = cell(row.cells, 'gtin');
    if (gtin !== undefined && gtin.trim() !== variant.gtin) {
      rowWarnings.push({
        rowNumber: row.rowNumber,
        code: 'import.read-only-column',
        column: 'gtin',
      });
    }
    for (const axis of model.axes) {
      const column = optionHeader(axis.code);
      const text = cell(row.cells, column);
      if (text === undefined || text.trim() === '') continue;
      if (optionOf(axis, text) !== (variant.options[axis.code] ?? null)) {
        rowWarnings.push({
          rowNumber: row.rowNumber,
          code: 'import.read-only-column',
          column,
        });
      }
    }

    const sku = (cell(row.cells, 'variant_sku') ?? '').trim();
    if (sku !== '' && sku !== variant.variantSku) {
      if (!VARIANT_SKU.test(sku)) {
        rowErrors.push({
          rowNumber: row.rowNumber,
          code: 'import.invalid-value',
          column: 'variant_sku',
        });
      } else {
        rowChanges.push({
          key: `sku:${variant.variantId}`,
          rowNumber: row.rowNumber,
          variantId: variant.variantId,
          variantCode: variant.variantCode,
          kind: 'sku',
          from: variant.variantSku,
          to: sku,
        });
      }
    }
    const selling = (cell(row.cells, 'selling') ?? '').trim().toLowerCase();
    if (selling !== '') {
      if (selling !== 'yes' && selling !== 'no') {
        rowErrors.push({
          rowNumber: row.rowNumber,
          code: 'import.invalid-value',
          column: 'selling',
        });
      } else if ((selling === 'yes') !== variant.selling) {
        rowChanges.push({
          key: `selling:${variant.variantId}`,
          rowNumber: row.rowNumber,
          variantId: variant.variantId,
          variantCode: variant.variantCode,
          kind: 'selling',
          from: variant.selling ? 'yes' : 'no',
          to: selling,
        });
      }
    }

    const price = cell(row.cells, 'price');
    if (price !== undefined && price.trim() !== '') {
      const minor = minorOf(price, model.currency);
      if (minor === null) {
        rowErrors.push({ rowNumber: row.rowNumber, code: 'import.invalid-value', column: 'price' });
      } else if (minor !== variant.price) {
        rowChanges.push({
          key: `price:${variant.variantId}`,
          rowNumber: row.rowNumber,
          variantId: variant.variantId,
          variantCode: variant.variantCode,
          kind: 'price',
          from: variant.price === null ? '' : inputOf(variant.price, model.currency),
          to: inputOf(minor, model.currency),
        });
      }
    }
    for (const source of model.sources) {
      const text = cell(row.cells, stockHeader(source.id));
      if (text === undefined || text.trim() === '') continue;
      const value = text.trim();
      if (!WHOLE.test(value) || Number(value) > MAX_ON_HAND) {
        rowErrors.push({
          rowNumber: row.rowNumber,
          code: 'import.invalid-value',
          column: stockHeader(source.id),
        });
        continue;
      }
      const current = variant.stock[source.id];
      const currentText = current === undefined ? '' : String(current.onHand);
      if (currentText === String(Number(value))) continue;
      const exported = (cell(row.cells, exportedHeader(source.id)) ?? '').trim();
      // A level that moved since the export, or one the file never recorded, is not applied
      // unless the seller confirms it.
      const stale = exported !== currentText;
      rowChanges.push({
        key: `stock:${variant.variantId}:${source.id}`,
        rowNumber: row.rowNumber,
        variantId: variant.variantId,
        variantCode: variant.variantCode,
        kind: 'stock',
        sourceId: source.id,
        from: currentText,
        to: String(Number(value)),
        ...(stale ? { code: 'import.stock-changed' as const } : {}),
      });
    }

    warnings.push(...rowWarnings);
    if (rowErrors.length > 0) errors.push(...rowErrors);
    else changes.push(...rowChanges);
  }

  // Two variants asking for the same new SKU: both rows fail (the route would refuse the pair).
  const wantedSku = new Map<string, CellChange[]>();
  for (const change of changes) {
    if (change.kind === 'sku') {
      wantedSku.set(change.to, [...(wantedSku.get(change.to) ?? []), change]);
    }
  }
  const dropped = new Set<string>();
  for (const group of wantedSku.values()) {
    if (group.length < 2) continue;
    for (const change of group) {
      dropped.add(change.key);
      errors.push({
        rowNumber: change.rowNumber,
        code: 'import.duplicate-row',
        column: 'variant_sku',
      });
    }
  }
  // A new SKU that is another variant's own today is taken (unless that variant gets another).
  const movedAway = new Set(
    changes.filter((change) => change.kind === 'sku').map((change) => change.variantId),
  );
  for (const change of changes) {
    if (change.kind !== 'sku' || dropped.has(change.key)) continue;
    const owner = bySku.get(change.to);
    if (
      owner !== undefined &&
      owner.variantId !== change.variantId &&
      !movedAway.has(owner.variantId)
    ) {
      dropped.add(change.key);
      errors.push({
        rowNumber: change.rowNumber,
        code: 'import.key-conflict',
        column: 'variant_sku',
      });
    }
  }
  // At least one live variant must keep selling.
  const sellingAfter = new Map(live.map((variant) => [variant.variantId, variant.selling]));
  for (const change of changes) {
    if (change.kind === 'selling') sellingAfter.set(change.variantId, change.to === 'yes');
  }
  if (live.length > 0 && ![...sellingAfter.values()].some(Boolean)) {
    for (const change of changes) {
      if (change.kind !== 'selling') continue;
      dropped.add(change.key);
      errors.push({ rowNumber: change.rowNumber, code: 'import.none-selling', column: 'selling' });
    }
  }
  const kept = changes.filter((change) => !dropped.has(change.key));

  const byRow = (a: RowIssue, b: RowIssue) => a.rowNumber - b.rowNumber;
  return {
    ok: true,
    preview: {
      changes: kept,
      errors: errors.length === 0 ? NO_ISSUES : errors.sort(byRow),
      warnings: warnings.sort(byRow),
      ignoredColumns,
      rowCount: table.rowCount,
    },
  };
}
