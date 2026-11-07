import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_VARIANT_VIEW } from '../../contracts/permissions';
import type { AdminVariantRow, AdminVariantsReader } from '../ports/admin-variants.reader';
import { invalid } from '../own-reads/own-reads.shared';
import { XLSX_CONTENT_TYPE, type SheetWriter } from '../ports/sheet-writer';
import type { VariantIssue, VariantRow, VariantsQuery } from '../ports/variant-admin.reader';
import { CSV_BOM, csvLine } from '../products/products-csv';
import {
  closedQuery,
  FILTER_KEYS,
  isAdmin,
  localesOf,
  parseFilter,
  queryOf,
  type AdminReadFailure,
} from '../variants/variant-admin.shared';
import { viewOf, type AdminVariantsDependencies } from '../variants/variant-views';

/** Variants one export may hold; more is refused whole and the admin narrows the filter. */
export const VARIANTS_EXPORT_MAX_ROWS = 10_000;
/** Variants read per chunk while the file streams. */
const CHUNK = 500;

export interface AdminVariantsExportDependencies extends AdminVariantsDependencies {
  /** Product type, option labels and Offer count of the compare columns (design 14b). */
  readonly adminVariantsReader: AdminVariantsReader;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

export interface AdminVariantsExportOutput {
  readonly filename: string;
  readonly contentType: string;
  /** The file in chunks, the header first; each chunk reads its own page. */
  readonly chunks: AsyncIterable<string | Uint8Array>;
}

export type AdminVariantsExportFailure =
  | AdminReadFailure
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number };

const ISSUE_LABELS: Readonly<Record<VariantIssue, string>> = Object.freeze({
  'no-seller-selling': 'No seller selling',
  'missing-gtin': 'Missing GTIN',
  'duplicate-gtin': 'Duplicate GTIN',
  'no-image': 'No image',
  'missing-language': 'Missing language',
});

/** The header cells before the option columns and after them (design 14b, the compare columns). */
export const VARIANT_EXPORT_HEAD = ['product_code', 'variant_code', 'product_type'] as const;
export const VARIANT_EXPORT_TAIL = ['gtin', 'offer_count'] as const;
/** The cells the Variants tab adds after the compare columns. */
const TAB_HEADER = ['Product', 'Variant', 'Status', 'Sellers selling', 'Issues'] as const;
/** The header of the option column of an axis. */
export const optionHeader = (attributeCode: string): string => `option[${attributeCode}]`;

type Cell = string | number | null;

/**
 * `admin-variants.export` (variants V6; the products export pattern, catalog design 9.2c): the
 * variants the Variants tab's filter matches (`q`, `typeCode`, `issue`), at most
 * {@link VARIANTS_EXPORT_MAX_ROWS}, as CSV (default) or XLSX. The file streams: each chunk of
 * {@link CHUNK} variants reads its own page in a read-only unit. CSV text cells that a
 * spreadsheet would run as a formula get a leading quote; XLSX cells are all string values,
 * never formulas (the {@link SheetWriter} contract). Columns (design 14b, then the tab's own):
 * `product_code`, `variant_code`, `product_type`, one `option[<attribute code>]` per axis any
 * exported product varies on (the option label in the default locale, empty where a product has
 * no such axis), `gtin`, `offer_count`, then Product, Variant, Status, Sellers selling, Issues. Rule: the key `catalog.variant.view` and the
 * admin population.
 */
export class AdminVariantsExport extends UseCase<
  Record<string, unknown>,
  AdminVariantsExportOutput,
  AdminVariantsExportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-variants-export',
    rule: { kind: 'permissions', allOf: [CATALOG_VARIANT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminVariantsExportDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Record<string, unknown>,
  ): Promise<Result<AdminVariantsExportOutput, AdminVariantsExportFailure>> {
    if (!isAdmin(context)) return err({ code: 'access.denied' });
    const query = closedQuery(input, [...FILTER_KEYS, 'format']);
    if (!query.ok) return query;
    const format = query.value['format'] ?? 'csv';
    if (format !== 'csv' && format !== 'xlsx') return invalid('format', 'value');
    const filter = parseFilter(query.value);
    if (!filter.ok) return filter;
    const locales = localesOf(this.deps.policy, context);
    if (!locales.ok) return locales;
    const { deps } = this;

    // Refused whole before the first byte: the matching variants are counted up to one past the
    // cap (pages of ids and facts only, no file is built).
    const base = queryOf(filter.value, { after: null, limit: CHUNK }, locales.value);
    const counted = await this.#countUpTo(context, base, VARIANTS_EXPORT_MAX_ROWS + 1);
    if (!counted.ok) return counted;
    if (counted.value.total > VARIANTS_EXPORT_MAX_ROWS) {
      return err({ code: 'batch.too-large', max: VARIANTS_EXPORT_MAX_ROWS });
    }
    // The option columns are the union of the axes of the products the file holds.
    const productIds = [...counted.value.productIds];
    const axes = await deps.unitOfWork.run(
      context.market,
      async () => ok(await deps.adminVariantsReader.axisCodes(context.market, productIds)),
      { readOnly: true },
    );
    if (!axes.ok) return err({ code: 'access.unavailable' });

    const day = deps.clock.now().toString().slice(0, 10);
    const groups = this.#rows(context, base, locales.value.default, axes.value);
    if (format === 'xlsx') {
      return ok({
        filename: `variants-${day}.xlsx`,
        contentType: XLSX_CONTENT_TYPE,
        chunks: deps.sheetWriter.xlsx('Variants', textRows(groups)),
      });
    }
    return ok({
      filename: `variants-${day}.csv`,
      contentType: 'text/csv; charset=utf-8',
      chunks: csvChunks(groups),
    });
  }

  /** Counts matching variants page by page, stopping at `cap`. */
  async #countUpTo(
    context: CallContext,
    base: VariantsQuery,
    cap: number,
  ): Promise<Result<{ total: number; productIds: ReadonlySet<Id<'Product'>> }, AdminReadFailure>> {
    const { market } = context;
    let after: string | null = null;
    let total = 0;
    const productIds = new Set<Id<'Product'>>();
    do {
      const query: VariantsQuery = { ...base, after, limit: CHUNK };
      const page = await this.deps.unitOfWork.run(
        market,
        async () => ok(await this.deps.variantAdminReader.variantsPage(market, query)),
        { readOnly: true },
      );
      if (!page.ok) return err({ code: 'access.unavailable' });
      total += page.value.rows.length;
      for (const row of page.value.rows) productIds.add(row.productId);
      after = page.value.nextAfter;
    } while (after !== null && total < cap);
    return ok({ total, productIds });
  }

  /** The compare columns of one page, by variant code (the products' published variants). */
  async #details(
    context: CallContext,
    rows: readonly VariantRow[],
    locale: string,
  ): Promise<ReadonlyMap<string, AdminVariantRow>> {
    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok(
          await this.deps.adminVariantsReader.rows(
            market,
            [...new Set(rows.map((row) => row.productId))],
            locale,
          ),
        ),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('catalog.admin-variants-export: the read failed');
    return new Map(read.value.map((detail) => [detail.variantCode, detail]));
  }

  async *#rows(
    context: CallContext,
    base: VariantsQuery,
    locale: string,
    axes: readonly string[],
  ): AsyncGenerator<readonly (readonly Cell[])[]> {
    const { market } = context;
    yield [
      [...VARIANT_EXPORT_HEAD, ...axes.map(optionHeader), ...VARIANT_EXPORT_TAIL, ...TAB_HEADER],
    ];
    let after: string | null = null;
    let written = 0;
    do {
      const query: VariantsQuery = { ...base, after, limit: CHUNK };
      const page = await this.deps.unitOfWork.run(
        market,
        async () => ok(await this.deps.variantAdminReader.variantsPage(market, query)),
        { readOnly: true },
      );
      if (!page.ok) throw new Error('catalog.admin-variants-export: the read failed');
      const rows = page.value.rows.slice(0, VARIANTS_EXPORT_MAX_ROWS - written);
      written += rows.length;
      const details = await this.#details(context, rows, locale);
      yield rows.map((row) => {
        const view = viewOf(row, locale);
        const detail = details.get(view.variantCode);
        return [
          view.productCode,
          view.variantCode,
          detail?.typeCode ?? '',
          ...axes.map(
            (axis) => detail?.options.find((option) => option.attributeCode === axis)?.label ?? '',
          ),
          view.gtin ?? '',
          detail?.offerCount ?? null,
          view.productName ?? '',
          view.label ?? '',
          view.status === 'paused' ? 'Paused' : 'Live',
          view.sellers,
          view.issues.map((issue) => ISSUE_LABELS[issue]).join('; '),
        ];
      });
      after = page.value.nextAfter;
    } while (after !== null && written < VARIANTS_EXPORT_MAX_ROWS);
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

/** XLSX: every cell as text; a count is written as the digits. */
async function* textRows(
  groups: AsyncIterable<readonly (readonly Cell[])[]>,
): AsyncGenerator<readonly string[]> {
  for await (const group of groups) {
    for (const row of group) yield row.map((cell) => (cell === null ? '' : String(cell)));
  }
}
