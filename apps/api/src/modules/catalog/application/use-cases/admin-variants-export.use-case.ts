import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import type { AdminProductsReader } from '../ports/admin-products.reader';
import type { AdminVariantsReader } from '../ports/admin-variants.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import { XLSX_CONTENT_TYPE, type SheetWriter } from '../ports/sheet-writer';
import { CSV_BOM, csvLine } from '../products/products-csv';
import { filterOfSelector, parseSelector } from './admin-products-list.use-case';
import {
  EXPORT_FORMATS,
  EXPORT_MAX_ROWS,
  type ExportFormat,
} from './admin-products-export.use-case';

export { EXPORT_FORMATS, EXPORT_MAX_ROWS };
export type { ExportFormat };

/** Products read per chunk while the file streams. */
const CHUNK = 500;

/** What the first read settles: the products, the row count (null: too many products) and axes. */
interface Picked {
  readonly ids: readonly Id<'Product'>[];
  readonly rows: number | null;
  readonly total: number;
  /** What `total` counts when the export is refused: the products matched or the variant rows. */
  readonly unit: 'products' | 'rows';
  readonly axes: readonly string[];
}

/** The header cells before the option columns and after them (design 14b). */
export const VARIANT_EXPORT_HEAD = ['product_code', 'variant_code', 'product_type'] as const;
export const VARIANT_EXPORT_TAIL = ['gtin', 'offer_count'] as const;
/** The header of the option column of an axis. */
export const optionHeader = (attributeCode: string): string => `option[${attributeCode}]`;

export interface AdminVariantsExportInput {
  readonly format?: unknown;
  readonly [selectorKey: string]: unknown;
}

export interface AdminVariantsExportOutput {
  readonly filename: string;
  readonly contentType: string;
  /** The file, in chunks: the first holds the header. Text for a CSV, bytes for an XLSX. */
  readonly chunks: AsyncIterable<string | Uint8Array>;
}

export type AdminVariantsExportFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | {
      readonly code: 'export.too-large';
      readonly max: number;
      readonly total?: number;
      readonly unit?: 'products' | 'rows';
    }
  | ValidationFailure;

export interface AdminVariantsExportDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly adminProductsReader: AdminProductsReader;
  readonly adminVariantsReader: AdminVariantsReader;
  readonly policy: CatalogMarketPolicy;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

const SELECTOR_KEYS = new Set([
  'view',
  'q',
  'scope',
  'status',
  'categoryId',
  'typeCode',
  'sellerId',
]);

/**
 * `admin-variants.export` (catalog design 14b; Catalogue > Variants): one row per variant of the
 * products the list filters match, read from each product's **published** revision (a product never
 * published has no row, a `proposed` variant that exists only in a pending revision or the working
 * copy has none). Columns: `product_code`, `variant_code`, `product_type`, one `option[<attribute
 * code>]` per axis any exported product varies on (empty where a product has no such axis; the
 * option's label in the Market's default locale), `gtin`, `offer_count`. No price, stock or seller
 * column. At most {@link EXPORT_MAX_ROWS} rows: more is refused whole as `export.too-large` with
 * `max` (and `total`). Rule: the key `catalog.product.view` and the admin population. The answer is
 * a stream: each chunk of {@link CHUNK} products reads its own page (a read-only unit).
 *
 * CSV: a text cell that a spreadsheet would run as a formula gets a leading quote (the shared
 * guard, `@mondapac/platform-import`). XLSX: every cell is written as a string value by the
 * {@link SheetWriter}. A read: no audit row.
 */
export class AdminVariantsExport extends UseCase<
  AdminVariantsExportInput,
  AdminVariantsExportOutput,
  AdminVariantsExportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-variants-export',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminVariantsExportDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AdminVariantsExportInput,
  ): Promise<Result<AdminVariantsExportOutput, AdminVariantsExportFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('query', 'type');
    }
    for (const key of Object.keys(input)) {
      if (key !== 'format' && !SELECTOR_KEYS.has(key)) return invalid(key, 'unknown');
    }
    const format = input.format ?? 'csv';
    if (format !== 'csv' && format !== 'xlsx') return invalid('format', 'value');
    const selector = parseSelector(input);
    if (!selector.ok) return selector;

    let locale: string;
    try {
      locale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const { deps } = this;
    const filter = filterOfSelector(selector.value, selector.value.view, locale);

    const picked = await deps.unitOfWork.run<Picked, never>(
      market,
      async (): Promise<Result<Picked, never>> => {
        const found = await deps.adminProductsReader.ids(market, filter, EXPORT_MAX_ROWS + 1);
        if (found.length > EXPORT_MAX_ROWS) {
          const [total] = await deps.adminProductsReader.counts(market, [filter]);
          return ok({
            ids: found,
            rows: null,
            total: total ?? found.length,
            unit: 'products',
            axes: [],
          });
        }
        const rows = await deps.adminVariantsReader.count(market, found);
        if (rows > EXPORT_MAX_ROWS)
          return ok({ ids: found, rows, total: rows, unit: 'rows', axes: [] });
        return ok({
          ids: found,
          rows,
          total: rows,
          unit: 'rows',
          axes: await deps.adminVariantsReader.axisCodes(market, found),
        });
      },
      { readOnly: true },
    );
    if (!picked.ok) return err({ code: 'access.unavailable' });
    if (picked.value.rows === null || picked.value.rows > EXPORT_MAX_ROWS) {
      return err({
        code: 'export.too-large',
        max: EXPORT_MAX_ROWS,
        total: picked.value.total,
        unit: picked.value.unit,
      });
    }

    const day = deps.clock.now().toString().slice(0, 10);
    const rows = this.#rows(context, picked.value.ids, picked.value.axes, locale);
    if (format === 'xlsx') {
      return ok({
        filename: `variants-${day}.xlsx`,
        contentType: XLSX_CONTENT_TYPE,
        chunks: deps.sheetWriter.xlsx('Variants', textRows(rows)),
      });
    }
    return ok({
      filename: `variants-${day}.csv`,
      contentType: 'text/csv; charset=utf-8',
      chunks: csvChunks(rows),
    });
  }

  /** The rows of the file, a group per page of products: the header group first. */
  async *#rows(
    context: CallContext,
    ids: readonly Id<'Product'>[],
    axes: readonly string[],
    locale: string,
  ): AsyncGenerator<readonly (readonly string[])[]> {
    const { market } = context;
    const { deps } = this;
    yield [[...VARIANT_EXPORT_HEAD, ...axes.map(optionHeader), ...VARIANT_EXPORT_TAIL]];
    for (let start = 0; start < ids.length; start += CHUNK) {
      const chunk = ids.slice(start, start + CHUNK);
      const read = await deps.unitOfWork.run(
        market,
        async () => ok(await deps.adminVariantsReader.rows(market, chunk, locale)),
        { readOnly: true },
      );
      if (!read.ok) throw new Error('catalog.admin-variants-export: the read failed');
      yield read.value.map((row) => [
        row.productCode,
        row.variantCode,
        row.typeCode,
        ...axes.map(
          (axis) => row.options.find((option) => option.attributeCode === axis)?.label ?? '',
        ),
        row.gtin ?? '',
        String(row.offerCount),
      ]);
    }
  }
}

/** CSV: the byte order mark before the header, then each group of rows as one chunk of lines. */
async function* csvChunks(
  groups: AsyncIterable<readonly (readonly string[])[]>,
): AsyncGenerator<string> {
  let first = true;
  for await (const group of groups) {
    const text = group.map((row) => csvLine(row)).join('');
    yield first ? CSV_BOM + text : text;
    first = false;
  }
}

/** XLSX: every cell as text. */
async function* textRows(
  groups: AsyncIterable<readonly (readonly string[])[]>,
): AsyncGenerator<readonly string[]> {
  for await (const group of groups) {
    for (const row of group) yield row;
  }
}
