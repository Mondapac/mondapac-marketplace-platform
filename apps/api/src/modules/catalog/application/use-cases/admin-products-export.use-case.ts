import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import { productIdOf } from '../products/product-lifecycle';
import {
  CSV_BOM,
  csvLine,
  EXPORT_COLUMNS,
  EXPORT_HEADERS,
  type ExportColumn,
} from '../products/products-csv';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import type { AdminProductRow, AdminProductsReader } from '../ports/admin-products.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { SellerNamesReader } from '../ports/seller-names.reader';
import { XLSX_CONTENT_TYPE, type SheetWriter } from '../ports/sheet-writer';
import { BULK_MAX_IDS } from './admin-products-bulk.use-case';
import { filterOfSelector, parseSelector } from './admin-products-list.use-case';

export const EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Products one export may hold; more is refused whole and the admin narrows the filter. */
export const EXPORT_MAX_ROWS = 10_000;
export { EXPORT_COLUMNS };
/** Products read per chunk while the file streams. */
const CHUNK = 500;

export interface AdminProductsExportInput {
  readonly format?: unknown;
  /** Comma-separated optional columns, in the order shown (the page's column picker). */
  readonly columns?: unknown;
  /** Comma-separated product ids; without it the selector keys pick the products. */
  readonly ids?: unknown;
  readonly [selectorKey: string]: unknown;
}

export interface AdminProductsExportOutput {
  readonly filename: string;
  readonly contentType: string;
  /**
   * The file, in chunks: the first holds the header. Each chunk reads its own page of products.
   * Text for a CSV, bytes for an XLSX.
   */
  readonly chunks: AsyncIterable<string | Uint8Array>;
}

export type AdminProductsExportFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'product.not-found' }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number }
  | ValidationFailure;

export interface AdminProductsExportDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly adminProductsReader: AdminProductsReader;
  readonly policy: CatalogMarketPolicy;
  readonly sellerNames: SellerNamesReader;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

/** One cell of a row before it is written: text, a count or nothing. */
type Cell = string | number | null;

const OWN_KEYS = new Set(['format', 'columns', 'ids']);
const SELECTOR_KEYS = new Set([
  'view',
  'q',
  'scope',
  'status',
  'categoryId',
  'typeCode',
  'sellerId',
]);

const STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  published: 'Active',
  paused: 'Inactive',
  unpublished: 'Unpublished',
  withdrawn: 'Withdrawn',
  retired: 'Retired',
  matched: 'Matched',
});

/**
 * `admin-products.export` (catalog design 9.2c; Export in the Bulk action menu): the products of
 * the Products page as a CSV file with the columns the page shows. Product, product code, category
 * and status are always there; `columns` adds the optional ones in the order given. The products
 * are the explicit `ids` (at most {@link BULK_MAX_IDS}; any id that is not a product of the
 * caller's Market refuses the whole request as `product.not-found`) or what the selector keys
 * (`view`, `q`, `scope`, `status`, `categoryId`, `typeCode`, `sellerId`) match, at most
 * {@link EXPORT_MAX_ROWS}, newest change first. Rule: the key `catalog.product.view` and the admin
 * population. The answer is a stream: the use case resolves and checks the ids, then each chunk of
 * {@link CHUNK} products reads its own page (a read-only unit) and its store names, so no export
 * holds the whole file. The same rows leave as `csv` (default) or `xlsx`. CSV: text cells that a
 * spreadsheet would run as a formula (`=`, `+`, `-`, `@`, tab, carriage return at the start) get a
 * leading quote. XLSX: **every cell is written as a string value**, never a formula (the
 * {@link SheetWriter} contract), so nothing is prefixed and the text is exactly the product's.
 * Any other format is `validation.failed`.
 */
export class AdminProductsExport extends UseCase<
  AdminProductsExportInput,
  AdminProductsExportOutput,
  AdminProductsExportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-products-export',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminProductsExportDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AdminProductsExportInput,
  ): Promise<Result<AdminProductsExportOutput, AdminProductsExportFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('query', 'type');
    }
    for (const key of Object.keys(input)) {
      if (!OWN_KEYS.has(key) && !SELECTOR_KEYS.has(key)) return invalid(key, 'unknown');
    }
    const format = input.format ?? 'csv';
    if (format !== 'csv' && format !== 'xlsx') return invalid('format', 'value');
    const columns = this.#columns(input.columns);
    if (!columns.ok) return columns;

    let locale: string;
    try {
      locale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const { deps } = this;

    let ids: readonly Id<'Product'>[];
    if (input.ids !== undefined && input.ids !== '') {
      if (typeof input.ids !== 'string') return invalid('ids', 'type');
      const parts = input.ids.split(',');
      if (parts.length > BULK_MAX_IDS) return err({ code: 'batch.too-large', max: BULK_MAX_IDS });
      const parsed: Id<'Product'>[] = [];
      for (const part of parts) {
        const id = productIdOf(part);
        if (id === null) return invalid('ids', 'format');
        parsed.push(id);
      }
      if (new Set(parsed).size !== parsed.length) return invalid('ids', 'duplicate');
      const found = await deps.unitOfWork.run(
        market,
        async () => ok(await deps.adminProductsReader.existing(market, parsed)),
        { readOnly: true },
      );
      if (!found.ok) return err({ code: 'access.unavailable' });
      if (parsed.some((id) => !found.value.has(id))) return err({ code: 'product.not-found' });
      ids = parsed;
    } else {
      const selector = parseSelector(input);
      if (!selector.ok) return selector;
      const filter = filterOfSelector(selector.value, selector.value.view, locale);
      const picked = await deps.unitOfWork.run(
        market,
        async () => {
          const found = await deps.adminProductsReader.ids(market, filter, EXPORT_MAX_ROWS + 1);
          if (found.length <= EXPORT_MAX_ROWS) return ok({ found, total: found.length });
          const [total] = await deps.adminProductsReader.counts(market, [filter]);
          return ok({ found, total: total ?? found.length });
        },
        { readOnly: true },
      );
      if (!picked.ok) return err({ code: 'access.unavailable' });
      if (picked.value.found.length > EXPORT_MAX_ROWS) {
        return err({ code: 'batch.too-large', max: EXPORT_MAX_ROWS, total: picked.value.total });
      }
      ids = picked.value.found;
    }

    const day = deps.clock.now().toString().slice(0, 10);
    const rows = this.#rows(context, ids, columns.value, locale);
    if (format === 'xlsx') {
      return ok({
        filename: `products-${day}.xlsx`,
        contentType: XLSX_CONTENT_TYPE,
        chunks: deps.sheetWriter.xlsx('Products', textRows(rows)),
      });
    }
    return ok({
      filename: `products-${day}.csv`,
      contentType: 'text/csv; charset=utf-8',
      chunks: csvChunks(rows),
    });
  }

  #columns(value: unknown): Result<readonly ExportColumn[], ValidationFailure> {
    if (value === undefined || value === '') return ok([]);
    if (typeof value !== 'string') return invalid('columns', 'type');
    const seen = new Set<ExportColumn>();
    for (const part of value.split(',')) {
      if (!(EXPORT_COLUMNS as readonly string[]).includes(part)) return invalid('columns', 'value');
      seen.add(part as ExportColumn);
    }
    return ok([...seen]);
  }

  /** The rows of the file, a group per page of products: the header group first. */
  async *#rows(
    context: CallContext,
    ids: readonly Id<'Product'>[],
    columns: readonly ExportColumn[],
    locale: string,
  ): AsyncGenerator<readonly (readonly Cell[])[]> {
    const { market } = context;
    const { deps } = this;
    const optional = columns.filter((column) => column !== 'code');
    yield [
      [
        EXPORT_HEADERS.name,
        EXPORT_HEADERS.code,
        EXPORT_HEADERS.category,
        EXPORT_HEADERS.status,
        ...optional.map((column) => EXPORT_HEADERS[column]),
      ],
    ];
    for (let start = 0; start < ids.length; start += CHUNK) {
      const chunk = ids.slice(start, start + CHUNK);
      const read = await deps.unitOfWork.run(
        market,
        async () => ok(await deps.adminProductsReader.rowsByIds(market, chunk, locale)),
        { readOnly: true },
      );
      if (!read.ok) throw new Error('catalog.admin-products-export: the read failed');
      const rows = read.value;
      const owners = optional.includes('seller')
        ? [
            ...new Set(
              rows.flatMap((row) => (row.ownerSellerId === null ? [] : [row.ownerSellerId])),
            ),
          ]
        : [];
      const names =
        owners.length === 0
          ? new Map<string, string>()
          : await deps.sellerNames.storeNames(context, owners);
      yield rows.map((row) => [
        row.name ?? '',
        row.productCode,
        row.categoryName ?? '',
        STATUS_LABELS[row.status] ?? row.status,
        ...optional.map((column) => cellOf(column, row, names)),
      ]);
    }
  }
}

/** CSV: the byte order mark before the header, then each group of rows as one chunk of lines. */
async function* csvChunks(
  groups: AsyncIterable<readonly (readonly Cell[])[]>,
): AsyncGenerator<string> {
  let first = true;
  for await (const group of groups) {
    const text = group.map((row) => csvLine(row)).join('');
    yield first ? CSV_BOM + text : text;
    first = false;
  }
}

/** XLSX: every cell as text; a count is written as the digits, nothing is a number or formula. */
async function* textRows(
  groups: AsyncIterable<readonly (readonly Cell[])[]>,
): AsyncGenerator<readonly string[]> {
  for await (const group of groups) {
    for (const row of group) yield row.map((cell) => (cell === null ? '' : String(cell)));
  }
}

function cellOf(
  column: ExportColumn,
  row: AdminProductRow,
  names: ReadonlyMap<string, string>,
): Cell {
  switch (column) {
    case 'code':
      return row.productCode;
    case 'offers':
      return row.offerCount;
    case 'updated':
      return row.updatedAt.toString();
    case 'created':
      return row.createdAt.toString();
    case 'type':
      return row.typeCode;
    case 'scope':
      return row.scope === 'PLATFORM' ? 'Platform' : 'Seller';
    case 'seller':
      return row.ownerSellerId === null ? 'Platform' : (names.get(row.ownerSellerId) ?? '');
  }
}
