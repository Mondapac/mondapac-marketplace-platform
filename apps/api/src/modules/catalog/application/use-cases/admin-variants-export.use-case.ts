import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_VARIANT_VIEW } from '../../contracts/permissions';
import { invalid } from '../own-reads/own-reads.shared';
import { XLSX_CONTENT_TYPE, type SheetWriter } from '../ports/sheet-writer';
import type { VariantIssue, VariantsQuery } from '../ports/variant-admin.reader';
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

const HEADER = [
  'Product',
  'Product code',
  'Variant',
  'Variant code',
  'GTIN',
  'Status',
  'Sellers selling',
  'Issues',
] as const;

type Cell = string | number | null;

/**
 * `admin-variants.export` (variants V6; the products export pattern, catalog design 9.2c): the
 * variants the Variants tab's filter matches (`q`, `typeCode`, `issue`), at most
 * {@link VARIANTS_EXPORT_MAX_ROWS}, as CSV (default) or XLSX. The file streams: each chunk of
 * {@link CHUNK} variants reads its own page in a read-only unit. CSV text cells that a
 * spreadsheet would run as a formula get a leading quote; XLSX cells are all string values,
 * never formulas (the {@link SheetWriter} contract). Rule: the key `catalog.variant.view` and the
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
    if (counted.value > VARIANTS_EXPORT_MAX_ROWS) {
      return err({ code: 'batch.too-large', max: VARIANTS_EXPORT_MAX_ROWS });
    }

    const day = deps.clock.now().toString().slice(0, 10);
    const groups = this.#rows(context, base, locales.value.default);
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
  ): Promise<Result<number, AdminReadFailure>> {
    const { market } = context;
    let after: string | null = null;
    let total = 0;
    do {
      const query: VariantsQuery = { ...base, after, limit: CHUNK };
      const page = await this.deps.unitOfWork.run(
        market,
        async () => ok(await this.deps.variantAdminReader.variantsPage(market, query)),
        { readOnly: true },
      );
      if (!page.ok) return err({ code: 'access.unavailable' });
      total += page.value.rows.length;
      after = page.value.nextAfter;
    } while (after !== null && total < cap);
    return ok(total);
  }

  async *#rows(
    context: CallContext,
    base: VariantsQuery,
    locale: string,
  ): AsyncGenerator<readonly (readonly Cell[])[]> {
    const { market } = context;
    yield [[...HEADER]];
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
      yield rows.map((row) => {
        const view = viewOf(row, locale);
        return [
          view.productName ?? '',
          view.productCode,
          view.label ?? '',
          view.variantCode,
          view.gtin ?? '',
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
