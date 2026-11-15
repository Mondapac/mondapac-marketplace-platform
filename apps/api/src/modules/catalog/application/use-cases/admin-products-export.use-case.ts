import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import { productIdOf } from '../products/product-lifecycle';
import {
  EXPORT_COLUMNS,
  EXPORT_HEADERS,
  type ExportCell as Cell,
  type ExportColumn,
} from '../products/products-csv';
import {
  buildExportFile,
  checkExportSize,
  LIST_EXPORT_MAX_ROWS,
  parseExportColumns,
  parseExportFormat,
  parseExportIds,
  type SheetWriter,
} from '../../../../platform/list-export';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import type { AdminProductRow, AdminProductsReader } from '../ports/admin-products.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { SellerNamesReader } from '../ports/seller-names.reader';
import { BULK_MAX_IDS } from './admin-products-bulk.use-case';
import { filterOfSelector, parseSelector } from './admin-products-list.use-case';

export { EXPORT_FORMATS, type ExportFormat } from '../../../../platform/list-export';

/** Products one export may hold; more is refused whole and the admin narrows the filter. */
export const EXPORT_MAX_ROWS = LIST_EXPORT_MAX_ROWS;
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
    const format = parseExportFormat(input.format);
    if (!format.ok) return format;
    const columns = parseExportColumns(input.columns, EXPORT_COLUMNS);
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
      const listed = parseExportIds(input.ids, BULK_MAX_IDS, productIdOf);
      if (!listed.ok) return listed;
      const parsed = listed.value;
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
      const size = checkExportSize(picked.value.found.length, picked.value.total);
      if (!size.ok) return size;
      ids = picked.value.found;
    }

    const day = deps.clock.now().toString().slice(0, 10);
    const file = buildExportFile({
      format: format.value,
      baseName: 'products',
      sheetName: 'Products',
      day,
      groups: this.#rows(context, ids, columns.value, locale),
      sheetWriter: deps.sheetWriter,
    });
    return ok(file);
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
    case 'tags':
      // The names in the Market default language, in the order entered; a spreadsheet cell.
      return row.topics.map((topic) => topic.name ?? topic.slug).join('; ');
    case 'seller':
      return row.ownerSellerId === null ? 'Platform' : (names.get(row.ownerSellerId) ?? '');
  }
}
