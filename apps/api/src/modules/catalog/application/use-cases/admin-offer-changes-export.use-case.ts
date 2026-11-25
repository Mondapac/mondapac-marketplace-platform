import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import { XLSX_CONTENT_TYPE, type SheetWriter } from '../../../../platform/list-export/sheet-writer';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import type { AdminOfferChangeRow } from '../offer-changes/admin-offer-change-rows';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import { CSV_BOM, csvLine } from '../products/products-csv';
import {
  OFFER_CHANGES_FILTER_KEYS,
  OFFER_CHANGES_MAX_PAGE,
  OFFER_CHANGES_PAGE_MAX,
  type AdminOfferChangesList,
} from './admin-offer-changes-list.use-case';

/** Rows one export may hold: the rows the list's page read reaches (20 pages of 50). */
export const OFFER_CHANGES_EXPORT_MAX_ROWS = OFFER_CHANGES_PAGE_MAX * OFFER_CHANGES_MAX_PAGE;
export const OFFER_CHANGES_EXPORT_HEAD = [
  'change_id',
  'offer_id',
  'product_code',
  'product_name',
  'seller_id',
  'store_name',
  'seller_sku',
  'fields',
  'reasons',
  'submitted_at',
] as const;
const KEYS = [...OFFER_CHANGES_FILTER_KEYS, 'format'] as const;
const CHUNK = 500;

export interface AdminOfferChangesExportDependencies {
  /** The list's own use case: its gate, filters and order are the list's. */
  readonly changes: AdminOfferChangesList;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

export interface AdminOfferChangesExportOutput {
  readonly filename: string;
  readonly contentType: string;
  readonly chunks: AsyncIterable<string | Uint8Array>;
}

export type AdminOfferChangesExportFailure =
  | AccessDenied
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'batch.too-large'; readonly max: number }
  | ValidationFailure;

type Cell = string | number;

/**
 * `catalog.admin-offer-changes-export` (risk-based Offer approval slice 5): the held changes the
 * Edits list shows for the same filters (`reasons`, `sellerId`, `categoryId`, `submittedFrom`,
 * `submittedTo`, `q`), oldest submit first, as CSV (default) or XLSX. Read through the list's own
 * use case with its keyset cursor, so filter, order and access rule cannot drift. More than
 * {@link OFFER_CHANGES_EXPORT_MAX_ROWS} rows is refused whole as `batch.too-large`; a `q` whose
 * store names matched more stores than `sellers` answers is `validation.failed` (`q`,
 * `too-broad`). Codes and labels only: the proposed description (the seller's free text) is not
 * exported. CSV cells a spreadsheet would run as a formula get a leading quote; XLSX cells are
 * strings. Rule: `catalog.product.view` and the admin population.
 */
export class AdminOfferChangesExport extends UseCase<
  Record<string, unknown>,
  AdminOfferChangesExportOutput,
  AdminOfferChangesExportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-offer-changes-export',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminOfferChangesExportDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Record<string, unknown>,
  ): Promise<Result<AdminOfferChangesExportOutput, AdminOfferChangesExportFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const unknownKey = Object.keys(input).find((key) => !(KEYS as readonly string[]).includes(key));
    if (unknownKey !== undefined) return invalid(unknownKey, 'unknown');
    const format = input['format'] ?? 'csv';
    if (format !== 'csv' && format !== 'xlsx') return invalid('format', 'value');
    const { format: _format, ...filters } = input;
    void _format;

    const rows: AdminOfferChangeRow[] = [];
    let afterId: string | null = null;
    do {
      const read = await this.deps.changes.execute(context, {
        ...filters,
        limit: OFFER_CHANGES_PAGE_MAX,
        ...(afterId === null ? {} : { afterId }),
      });
      if (!read.ok) return read;
      if (read.value.searchCapped) {
        return err({ code: 'validation.failed', fields: [{ path: 'q', code: 'too-broad' }] });
      }
      rows.push(...read.value.items);
      if (rows.length > OFFER_CHANGES_EXPORT_MAX_ROWS) {
        return err({ code: 'batch.too-large', max: OFFER_CHANGES_EXPORT_MAX_ROWS });
      }
      afterId = read.value.nextAfterId;
    } while (afterId !== null);
    const day = this.deps.clock.now().toString().slice(0, 10);
    const table: Cell[][] = [[...OFFER_CHANGES_EXPORT_HEAD], ...rows.map(rowOf)];
    if (format === 'xlsx') {
      return ok({
        filename: `offer-changes-${day}.xlsx`,
        contentType: XLSX_CONTENT_TYPE,
        chunks: this.deps.sheetWriter.xlsx('Offer changes', textRows(table)),
      });
    }
    return ok({
      filename: `offer-changes-${day}.csv`,
      contentType: 'text/csv; charset=utf-8',
      chunks: csvChunks(table),
    });
  }
}

function rowOf(row: AdminOfferChangeRow): Cell[] {
  return [
    row.changeId,
    row.offerId,
    row.product.productCode ?? '',
    row.product.name ?? '',
    row.sellerId,
    row.storeName ?? '',
    row.offer?.sellerSku ?? '',
    row.fields.join('; '),
    row.reasons.join('; '),
    row.submittedAt,
  ];
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
