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
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import { CSV_BOM, csvLine } from '../products/products-csv';
import {
  REVIEW_QUEUE_MAX_PAGE,
  REVIEW_QUEUE_PAGE_MAX,
  type ReviewQueueList,
  type ReviewQueueRow,
} from './review-queue-list.use-case';

/** Rows one export may hold: the rows the queue's page read reaches (20 pages of 50). */
export const REVIEW_QUEUE_EXPORT_MAX_ROWS = REVIEW_QUEUE_PAGE_MAX * REVIEW_QUEUE_MAX_PAGE;
export const REVIEW_QUEUE_EXPORT_HEAD = [
  'kind',
  'product_code',
  'product_name',
  'seller_id',
  'store_name',
  'seller_sku',
  'first_publication',
  'reasons',
  'required_checks',
  'has_images',
  'warnings',
  'submitted_at',
] as const;
const KEYS = [
  'kind',
  'sellerId',
  'firstPublication',
  'hasImages',
  'reasons',
  'categoryId',
  'submittedFrom',
  'submittedTo',
  'q',
  'format',
] as const;
const CHUNK = 500;

export interface ReviewQueueExportDependencies {
  /** The queue's own use case: its gate, filters and order are the list's. */
  readonly reviewQueue: ReviewQueueList;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

export interface ReviewQueueExportOutput {
  readonly filename: string;
  readonly contentType: string;
  readonly chunks: AsyncIterable<string | Uint8Array>;
}

export type ReviewQueueExportFailure =
  AccessDenied | { readonly code: 'batch.too-large'; readonly max: number } | ValidationFailure;

type Cell = string | number;

/**
 * `catalog.review-queue-export` (super list 13): the rows the Product review queue shows for the
 * same filters (`kind`, `sellerId`, `firstPublication`, `hasImages`, `reasons`, `categoryId`, `submittedFrom`,
 * `submittedTo`, and the search text `q`), oldest submit first, as
 * CSV (default) or XLSX. The rows are read through the queue's own use case with its keyset cursor, so the
 * filter, the order and the access rule cannot drift from the list; a queue longer than
 * {@link REVIEW_QUEUE_EXPORT_MAX_ROWS} rows is refused whole as `batch.too-large`, never cut, and a `q`
 * whose store names matched more stores than `sellers` answers as `validation.failed` (`q`,
 * `too-broad`).
 * CSV text cells that a spreadsheet would run as a formula get a leading quote; XLSX cells are
 * strings, never formulas. Rule: `catalog.product.view` and the admin population.
 */
export class ReviewQueueExport extends UseCase<
  Record<string, unknown>,
  ReviewQueueExportOutput,
  ReviewQueueExportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.review-queue-export',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewQueueExportDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Record<string, unknown>,
  ): Promise<Result<ReviewQueueExportOutput, ReviewQueueExportFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const unknownKey = Object.keys(input).find((key) => !(KEYS as readonly string[]).includes(key));
    if (unknownKey !== undefined) return invalid(unknownKey, 'unknown');
    const format = input['format'] ?? 'csv';
    if (format !== 'csv' && format !== 'xlsx') return invalid('format', 'value');
    const { format: _format, ...filters } = input;
    void _format;

    // The queue's keyset read (`afterId`, `limit`): each call starts at the cursor of the last, so
    // the cost stays that of one page and a row decided meanwhile cannot shift the rest.
    const rows: ReviewQueueRow[] = [];
    let afterId: string | null = null;
    do {
      const read = await this.deps.reviewQueue.execute(context, {
        ...filters,
        limit: REVIEW_QUEUE_PAGE_MAX,
        ...(afterId === null ? {} : { afterId }),
      });
      if (!read.ok) return read;
      // A search that matched more stores than `sellers` answers would export only part of the
      // queue: refused whole, never a partial file.
      if (read.value.searchCapped) {
        return err({ code: 'validation.failed', fields: [{ path: 'q', code: 'too-broad' }] });
      }
      rows.push(...read.value.items);
      if (rows.length > REVIEW_QUEUE_EXPORT_MAX_ROWS) {
        return err({ code: 'batch.too-large', max: REVIEW_QUEUE_EXPORT_MAX_ROWS });
      }
      afterId = read.value.nextAfterId;
    } while (afterId !== null);
    const day = this.deps.clock.now().toString().slice(0, 10);
    const table: Cell[][] = [[...REVIEW_QUEUE_EXPORT_HEAD], ...rows.map(rowOf)];
    if (format === 'xlsx') {
      return ok({
        filename: `review-queue-${day}.xlsx`,
        contentType: XLSX_CONTENT_TYPE,
        chunks: this.deps.sheetWriter.xlsx('Review queue', textRows(table)),
      });
    }
    return ok({
      filename: `review-queue-${day}.csv`,
      contentType: 'text/csv; charset=utf-8',
      chunks: csvChunks(table),
    });
  }
}

function rowOf(row: ReviewQueueRow): Cell[] {
  if (row.kind === 'offer-first-publication') {
    return [
      row.kind,
      row.product.productCode ?? '',
      row.product.name ?? '',
      row.sellerId,
      row.storeName ?? '',
      row.sellerSku,
      '',
      row.reasons.join('; '),
      '',
      '',
      '',
      row.submittedAt ?? '',
    ];
  }
  return [
    row.kind,
    row.product.productCode,
    row.product.name ?? '',
    row.sellerId,
    row.storeName ?? '',
    '',
    row.firstPublication ? 'yes' : 'no',
    row.reasons.join('; '),
    row.requiredChecks.join('; '),
    row.hasImages ? 'yes' : 'no',
    row.warnings.join('; '),
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
