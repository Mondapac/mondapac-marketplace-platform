import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { XLSX_CONTENT_TYPE, type SheetWriter } from '../../../../platform/list-export/sheet-writer';
import { CATALOG_ATTRIBUTE_VIEW } from '../../contracts/permissions';
import { closedInput, invalid, type ValidationFailure } from '../brands/brand-views';
import { readCatalogListInput } from '../lists/catalog-list-input';
import { CSV_BOM, csvLine } from '../products/products-csv';
import {
  GAP_MAX_PAGE,
  GAP_PAGE_DEFAULT,
  GAP_PAGE_MAX,
  GAP_PAGE_SCAN_MAX,
  GAP_SORTS,
  scanMissingDetails,
  type ProductsMissingDetailsListDependencies,
} from './products-missing-details-list.use-case';

/** Rows one export may hold; the scan behind the list reads at most as many products. */
export const MISSING_DETAILS_EXPORT_MAX_ROWS = GAP_PAGE_SCAN_MAX;
/** The header of the file. */
export const MISSING_DETAILS_EXPORT_HEAD = [
  'product_code',
  'name',
  'seller_id',
  'feature_set',
  'missing_count',
  'missing',
] as const;
const CODE = /^[a-z][a-z0-9_-]{0,63}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHUNK = 500;

export interface ProductsMissingDetailsExportDependencies extends Pick<
  ProductsMissingDetailsListDependencies,
  'unitOfWork' | 'detailsGapReader' | 'attributes' | 'policy' | 'familyResolver'
> {
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

export interface ProductsMissingDetailsExportOutput {
  readonly filename: string;
  readonly contentType: string;
  readonly chunks: AsyncIterable<string | Uint8Array>;
}

export type ProductsMissingDetailsExportFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'batch.too-large'; readonly max: number }
  | ValidationFailure;

type Cell = string | number;

/**
 * `catalog.products-missing-details-export` (super list 6): the rows the Missing details list
 * shows for the same filter (`sellerId`, `familyCode`, `q`) in the same order (`sort`,
 * `direction`), as CSV (default) or XLSX. It reads like the list's page read: the published
 * products up to {@link GAP_PAGE_SCAN_MAX}; when that cap was hit before the end of the Market the
 * file would be partial, so it is refused whole as `batch.too-large`. CSV text cells that a
 * spreadsheet would run as a formula get a leading quote; XLSX cells are string values, never
 * formulas. Rule: `catalog.attribute.view` and the admin population. One read-only unit.
 */
export class ProductsMissingDetailsExport extends UseCase<
  Record<string, unknown>,
  ProductsMissingDetailsExportOutput,
  ProductsMissingDetailsExportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.products-missing-details-export',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductsMissingDetailsExportDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Record<string, unknown>,
  ): Promise<Result<ProductsMissingDetailsExportOutput, ProductsMissingDetailsExportFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const body = closedInput(input, [
      'sellerId',
      'familyCode',
      'q',
      'search',
      'sort',
      'direction',
      'format',
    ]);
    if (!body.ok) return body;
    const format = body.value['format'] ?? 'csv';
    if (format !== 'csv' && format !== 'xlsx') return invalid('format', 'value');
    const rawSeller = body.value['sellerId'];
    let sellerId: string | null = null;
    if (rawSeller !== undefined && rawSeller !== null && rawSeller !== '') {
      if (typeof rawSeller !== 'string' || !ID.test(rawSeller))
        return invalid('sellerId', 'format');
      sellerId = rawSeller;
    }
    const rawFamily = body.value['familyCode'];
    let familyCode: string | null = null;
    if (rawFamily !== undefined && rawFamily !== null && rawFamily !== '') {
      if (typeof rawFamily !== 'string' || !CODE.test(rawFamily)) {
        return invalid('familyCode', 'format');
      }
      familyCode = rawFamily;
    }
    const { sellerId: _s, familyCode: _f, format: _x, ...rest } = body.value;
    void _s;
    void _f;
    void _x;
    const read = readCatalogListInput(rest, {
      sorts: GAP_SORTS,
      defaultSort: 'code',
      defaultDirection: (sort) => (sort === 'missing' ? 'desc' : 'asc'),
      pageDefault: GAP_PAGE_DEFAULT,
      pageMax: GAP_PAGE_MAX,
      maxPage: GAP_MAX_PAGE,
      cursorIdOf: () => null,
    });
    if (!read.ok) return read;
    if (read.value.mode !== 'page') return invalid('afterId', 'unsupported');
    const { paged } = read.value;
    const text = read.value.q === null ? null : read.value.q.toLowerCase();

    const { market } = context;
    const locales = this.deps.policy.locales(market);
    const ordered = [locales.default, ...locales.supported.filter((l) => l !== locales.default)];
    const unit = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok(
          await scanMissingDetails(
            this.deps,
            market,
            { afterId: null, sellerId, familyCode, text, limit: Infinity, all: true },
            locales.default,
            ordered,
          ),
        ),
      { readOnly: true },
    );
    if (!unit.ok) return err({ code: 'access.unavailable' });
    if (!unit.value.complete || unit.value.items.length > MISSING_DETAILS_EXPORT_MAX_ROWS) {
      return err({ code: 'batch.too-large', max: MISSING_DETAILS_EXPORT_MAX_ROWS });
    }
    const sign = paged.direction === 'asc' ? 1 : -1;
    const key = (item: (typeof unit.value.items)[number]): string | number =>
      paged.sort === 'name'
        ? (item.name ?? '').toLowerCase()
        : paged.sort === 'family'
          ? item.featureSetCode
          : paged.sort === 'missing'
            ? item.missing.length
            : item.productCode;
    const rows: Cell[][] = [...unit.value.items]
      .sort(
        (a, b) =>
          sign * (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) ||
          (a.productCode < b.productCode ? -1 : a.productCode > b.productCode ? 1 : 0),
      )
      .map((item) => [
        item.productCode,
        item.name ?? '',
        item.sellerId ?? '',
        item.featureSetCode,
        item.missing.length,
        item.missing.join('; '),
      ]);
    const day = this.deps.clock.now().toString().slice(0, 10);
    const table: Cell[][] = [[...MISSING_DETAILS_EXPORT_HEAD], ...rows];
    if (format === 'xlsx') {
      return ok({
        filename: `products-missing-details-${day}.xlsx`,
        contentType: XLSX_CONTENT_TYPE,
        chunks: this.deps.sheetWriter.xlsx('Missing details', textRows(table)),
      });
    }
    return ok({
      filename: `products-missing-details-${day}.csv`,
      contentType: 'text/csv; charset=utf-8',
      chunks: csvChunks(table),
    });
  }
}

async function* csvChunks(table: readonly (readonly Cell[])[]): AsyncGenerator<string> {
  await Promise.resolve();
  for (let start = 0; start < table.length; start += CHUNK) {
    const text = table
      .slice(start, start + CHUNK)
      .map((row) => csvLine(row))
      .join('');
    yield start === 0 ? CSV_BOM + text : text;
  }
}

async function* textRows(table: readonly (readonly Cell[])[]): AsyncGenerator<readonly string[]> {
  await Promise.resolve();
  for (const row of table) yield row.map((cell) => String(cell));
}
