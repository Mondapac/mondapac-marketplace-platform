import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import { invalid, sellerOf, type ValidationFailure } from '../own-reads/own-reads.shared';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type {
  OwnCatalogReader,
  OwnProductRow,
  OwnProductsFilter,
} from '../ports/own-catalog.reader';
import { XLSX_CONTENT_TYPE, type SheetWriter } from '../ports/sheet-writer';
import { productIdOf } from '../products/product-lifecycle';
import { csvChunks, textRows, type ExportCell } from '../products/products-csv';
import { EXPORT_FORMATS, EXPORT_MAX_ROWS } from './admin-products-export.use-case';
import {
  filterOf,
  OWN_LISTED_STATUSES,
  parseListQuery,
  type OwnProductSelector,
} from './own-products-list.use-case';

export { EXPORT_FORMATS };

/** Products one export may hold (the admin export's cap); more is refused whole. */
export const OWN_EXPORT_MAX_ROWS = EXPORT_MAX_ROWS;
/** Selected rows one export may name: one list page at its largest (100 rows). */
export const OWN_EXPORT_MAX_IDS = 100;
/** Products read per chunk while the file streams: the reader's page ceiling. */
const CHUNK = 100;

/** The columns of the seller list, as the page's column chooser names them. */
export const OWN_EXPORT_COLUMNS = [
  'product',
  'status',
  'category',
  'code',
  'updated',
  'created',
  'offers',
  'type',
] as const;
export type OwnExportColumn = (typeof OWN_EXPORT_COLUMNS)[number];

/** Always in the file, whatever `columns` says: the fixed columns of the page, first, in this order. */
const ALWAYS: readonly OwnExportColumn[] = ['product', 'status', 'category'];
/** The optional columns the page shows by default; used when `columns` is absent. */
const DEFAULT_COLUMNS: readonly OwnExportColumn[] = [...ALWAYS, 'code', 'updated'];

/** The header of each column (English; the file is data, not a page). */
export const OWN_EXPORT_HEADERS: Readonly<Record<OwnExportColumn, string>> = Object.freeze({
  product: 'Product',
  status: 'Status',
  category: 'Category',
  code: 'Product code',
  updated: 'Last changed',
  created: 'Created',
  offers: 'Offers',
  type: 'Product type',
});

const STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  draft: 'Draft',
  published: 'Live',
  matched: 'Live',
  unpublished: 'Unpublished',
  retired: 'Retired',
});

export interface OwnProductsExportInput {
  readonly format?: unknown;
  /** Comma-separated column keys, in the order shown (the page's column chooser). */
  readonly columns?: unknown;
  /** Comma-separated ids of the selected rows; without it the selector picks the products. */
  readonly productIds?: unknown;
  /** The selector and order of the list: view, q, status, categoryId, paused, typeCode, sort, direction. */
  readonly [selectorKey: string]: unknown;
}

export interface OwnProductsExportOutput {
  readonly filename: string;
  readonly contentType: string;
  /** The file in chunks, the header first: text for a CSV, bytes for an XLSX. */
  readonly chunks: AsyncIterable<string | Uint8Array>;
}

export type OwnProductsExportFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'product.not-found' }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number }
  | ValidationFailure;

export interface OwnProductsExportDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly ownReader: OwnCatalogReader;
  readonly policy: CatalogMarketPolicy;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

/** What the first read of an export found. */
type Head =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'too-broad' }
  | { readonly kind: 'too-large'; readonly total: number }
  | {
      readonly kind: 'snapshot';
      /** The matching products in file order, read once: the file holds exactly these. */
      readonly ids: readonly Id<'Product'>[];
      readonly firstRows: readonly OwnProductRow[];
    };

const OWN_KEYS = new Set(['format', 'columns', 'productIds']);

/**
 * `own-products.export` (catalog design 9.2c; Export on the seller Products page): the seller's
 * own products as a CSV or XLSX file with the columns the page shows. The selector is the list's
 * (`view`, `q`, `status`, `categoryId`, `paused`, `typeCode`, `sort`, `direction`, read by the
 * list's closed parser; `page`, `pageSize`, `afterId` and `limit` belong to the list and are
 * refused), plus `productIds` (at most {@link OWN_EXPORT_MAX_IDS}, comma-separated): the rows the
 * seller selected. With `productIds` exactly those products leave, in the order of `sort`; the
 * tab, search and filters are then only validated, and an id that is no listed product of the
 * calling seller refuses the whole request as `product.not-found` (the same answer for another
 * seller's product and an unknown id). Without it the selector picks the products, at most
 * {@link OWN_EXPORT_MAX_ROWS} (more is `batch.too-large`). `product`, `status` and `category` are
 * always in the file, first and in that order; `columns` adds `code`, `updated`, `created`,
 * `offers` and `type` after them in the order given (absent: code, updated, as the page shows by
 * default; the three fixed keys in `columns` are accepted and change nothing). Rule: the key
 * `catalog.own-product.view` and the seller population; the seller comes from the actor, so
 * another seller's product is never read. The file is built like the admin export's: the same
 * writers, so a CSV text cell that starts with a formula sign gets a leading quote and an XLSX
 * cell is always a string. The matching ids are read first, in file order (at most the cap), and
 * the rows are read by those ids in read-only units of {@link CHUNK} products each, so an edit
 * while the file streams cannot shift or repeat a row, and no export holds the whole file; the
 * first chunk is read before the answer, so a refusal never arrives after the status line.
 */
export class OwnProductsExport extends UseCase<
  OwnProductsExportInput,
  OwnProductsExportOutput,
  OwnProductsExportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-products-export',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnProductsExportDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnProductsExportInput,
  ): Promise<Result<OwnProductsExportOutput, OwnProductsExportFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('query', 'type');
    }
    const { format = 'csv', columns: rawColumns, productIds: rawIds, ...rest } = input;
    for (const key of Object.keys(input)) {
      if (OWN_KEYS.has(key)) continue;
      // The list's paging and the keyset parameters make no sense for a file.
      if (['page', 'pageSize', 'afterId', 'limit'].includes(key)) return invalid(key, 'unknown');
    }
    if (format !== 'csv' && format !== 'xlsx') return invalid('format', 'value');
    const columns = parseColumns(rawColumns);
    if (!columns.ok) return columns;
    const query = parseListQuery(rest);
    if (!query.ok) return query;
    const ids = parseIds(rawIds);
    if (!ids.ok) return ids;

    const { market } = context;
    const { deps } = this;
    let locale: string;
    try {
      locale = deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const selector: OwnProductSelector = query.value;
    const order = { sort: query.value.sort, direction: query.value.direction } as const;
    const filter: OwnProductsFilter =
      ids.value === null
        ? filterOf(selector, selector.view, locale)
        : {
            statuses: OWN_LISTED_STATUSES,
            inReview: false,
            paused: null,
            categoryId: null,
            typeCode: null,
            text: null,
            locale,
            productIds: ids.value,
          };

    const first = await deps.unitOfWork.run(
      market,
      async (): Promise<Result<Head, never>> => {
        // The matching ids first, in file order and one more than the cap: the rows are then read
        // by id, so an edit while the file streams can neither move nor repeat a row.
        const snapshot = await deps.ownReader.listProductIds(
          market,
          sellerId,
          filter,
          order,
          OWN_EXPORT_MAX_ROWS + 1,
        );
        if (snapshot.kind === 'too-broad') return ok({ kind: 'too-broad' });
        const found = snapshot.ids;
        if (ids.value !== null && found.length !== ids.value.length) {
          return ok({ kind: 'not-found' });
        }
        if (found.length > OWN_EXPORT_MAX_ROWS) {
          const totals = await deps.ownReader.countProductViews(market, sellerId, filter);
          const total = Object.values(totals.byStatus).reduce((sum, n) => sum + n, 0);
          return ok({ kind: 'too-large', total });
        }
        const firstRows = await deps.ownReader.listProductRowsByIds(
          market,
          sellerId,
          found.slice(0, CHUNK),
          locale,
        );
        return ok({ kind: 'snapshot', ids: found, firstRows });
      },
      { readOnly: true },
    );
    if (!first.ok) return err({ code: 'access.unavailable' });
    const head = first.value;
    if (head.kind === 'not-found') return err({ code: 'product.not-found' });
    if (head.kind === 'too-broad') return invalid('sort', 'too-broad');
    if (head.kind === 'too-large') {
      return err({ code: 'batch.too-large', max: OWN_EXPORT_MAX_ROWS, total: head.total });
    }

    const day = deps.clock.now().toString().slice(0, 10);
    const rows = this.#rows(context, sellerId, locale, columns.value, head.ids, head.firstRows);
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

  /** The rows of the file, a group per chunk of the snapshot's ids: the header group first. */
  async *#rows(
    context: CallContext,
    sellerId: Id<'Seller'>,
    locale: string,
    columns: readonly OwnExportColumn[],
    snapshot: readonly Id<'Product'>[],
    firstRows: readonly OwnProductRow[],
  ): AsyncGenerator<readonly (readonly ExportCell[])[]> {
    const { market } = context;
    const { deps } = this;
    yield [columns.map((column) => OWN_EXPORT_HEADERS[column])];
    yield firstRows.map((row) => columns.map((column) => cellOf(column, row)));
    for (let start = CHUNK; start < snapshot.length; start += CHUNK) {
      const read = await deps.unitOfWork.run(
        market,
        async () =>
          ok(
            await deps.ownReader.listProductRowsByIds(
              market,
              sellerId,
              snapshot.slice(start, start + CHUNK),
              locale,
            ),
          ),
        { readOnly: true },
      );
      if (!read.ok) throw new Error('catalog.own-products-export: the read failed');
      // A product deleted since the snapshot is absent; the rest keep their place.
      if (read.value.length === 0) continue;
      yield read.value.map((row) => columns.map((column) => cellOf(column, row)));
    }
  }
}

/**
 * The columns of the file: the always-there ones, then the optional keys in the order given;
 * absent, the page's defaults. Unknown keys are refused.
 */
function parseColumns(value: unknown): Result<readonly OwnExportColumn[], ValidationFailure> {
  if (value === undefined || value === '') return ok(DEFAULT_COLUMNS);
  if (typeof value !== 'string') return invalid('columns', 'type');
  const optional = new Set<OwnExportColumn>();
  for (const part of value.split(',')) {
    if (!(OWN_EXPORT_COLUMNS as readonly string[]).includes(part)) {
      return invalid('columns', 'value');
    }
    if (!ALWAYS.includes(part as OwnExportColumn)) optional.add(part as OwnExportColumn);
  }
  return ok([...ALWAYS, ...optional]);
}

/** The selected rows: null for none (the selector picks), else distinct product ids. */
function parseIds(
  value: unknown,
): Result<
  readonly Id<'Product'>[] | null,
  ValidationFailure | { readonly code: 'batch.too-large'; readonly max: number }
> {
  if (value === undefined || value === '') return ok(null);
  if (typeof value !== 'string') return invalid('productIds', 'type');
  const parts = value.split(',');
  if (parts.length > OWN_EXPORT_MAX_IDS) {
    return err({ code: 'batch.too-large', max: OWN_EXPORT_MAX_IDS });
  }
  const parsed: Id<'Product'>[] = [];
  for (const part of parts) {
    const id = productIdOf(part);
    if (id === null) return invalid('productIds', 'format');
    parsed.push(id);
  }
  if (new Set(parsed).size !== parsed.length) return invalid('productIds', 'duplicate');
  return ok(parsed);
}

function statusOf(row: OwnProductRow): string {
  const label = STATUS_LABELS[row.status] ?? row.status;
  return row.pausedAt === null ? label : `${label} (paused)`;
}

function cellOf(column: OwnExportColumn, row: OwnProductRow): ExportCell {
  switch (column) {
    case 'product':
      return row.name ?? '';
    case 'status':
      return statusOf(row);
    case 'category':
      return row.categoryName ?? '';
    case 'code':
      return row.productCode;
    case 'updated':
      return row.lastChangedAt.toString();
    case 'created':
      return row.createdAt.toString();
    case 'offers':
      return row.offerCount;
    case 'type':
      return row.typeCode;
  }
}
