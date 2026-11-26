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
import {
  OFFER_POST_REVIEWS_FILTER_KEYS,
  type AdminOfferPostReviewRow,
} from '../offer-post-review/post-review-rows';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import { CSV_BOM, csvLine } from '../products/products-csv';
import {
  OFFER_POST_REVIEWS_MAX_PAGE,
  OFFER_POST_REVIEWS_PAGE_MAX,
  OFFER_POST_REVIEWS_SORTS,
  type AdminOfferPostReviewsList,
} from './admin-offer-post-reviews-list.use-case';

/** Rows one export may hold: the rows the list's page read reaches (20 pages of 50). */
export const OFFER_POST_REVIEWS_EXPORT_MAX_ROWS =
  OFFER_POST_REVIEWS_PAGE_MAX * OFFER_POST_REVIEWS_MAX_PAGE;
export const OFFER_POST_REVIEWS_EXPORT_HEAD = [
  'post_review_id',
  'status',
  'reasons',
  'sample_percent',
  'sample_doubled',
  'offer_id',
  'offer_status',
  'listed',
  'seller_sku',
  'product_id',
  'product_name',
  'seller_id',
  'store_name',
  'opened_at',
  'decided_at',
  'decision_reason',
  'misconduct',
] as const;
const KEYS = [...OFFER_POST_REVIEWS_FILTER_KEYS, 'sort', 'direction', 'format'] as const;
const CHUNK = 500;

export interface AdminOfferPostReviewsExportDependencies {
  /** The list's own use case: its gate, filters and order are the list's. */
  readonly postReviewsList: AdminOfferPostReviewsList;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

export interface AdminOfferPostReviewsExportOutput {
  readonly filename: string;
  readonly contentType: string;
  readonly chunks: AsyncIterable<string | Uint8Array>;
}

export type AdminOfferPostReviewsExportFailure =
  | AccessDenied
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'batch.too-large'; readonly max: number }
  | ValidationFailure;

type Cell = string | number;

/**
 * `catalog.admin-offer-post-reviews-export` (risk-based Offer approval slice 6): the rows the
 * post-publication list shows for the same filters and order, as CSV (default) or XLSX, read
 * through the list's own use case page by page, so filter, order and access rule cannot drift.
 * More than {@link OFFER_POST_REVIEWS_EXPORT_MAX_ROWS} rows is refused whole as `batch.too-large`;
 * a `q` whose store names matched more stores than can be searched is `validation.failed` (`q`,
 * `too-broad`). Codes and labels only: never the note, never a price. CSV cells a spreadsheet
 * would run as a formula get a leading quote; XLSX cells are strings. Rule:
 * `catalog.product.view` and the admin population.
 */
export class AdminOfferPostReviewsExport extends UseCase<
  Record<string, unknown>,
  AdminOfferPostReviewsExportOutput,
  AdminOfferPostReviewsExportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-offer-post-reviews-export',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminOfferPostReviewsExportDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Record<string, unknown>,
  ): Promise<Result<AdminOfferPostReviewsExportOutput, AdminOfferPostReviewsExportFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const unknownKey = Object.keys(input).find((key) => !(KEYS as readonly string[]).includes(key));
    if (unknownKey !== undefined) return invalid(unknownKey, 'unknown');
    const format = input['format'] ?? 'csv';
    if (format !== 'csv' && format !== 'xlsx') return invalid('format', 'value');
    if (
      input['sort'] !== undefined &&
      !(OFFER_POST_REVIEWS_SORTS as readonly unknown[]).includes(input['sort'])
    ) {
      return invalid('sort', 'value');
    }
    const { format: _format, ...filters } = input;
    void _format;

    const rows: AdminOfferPostReviewRow[] = [];
    for (let page = 1; ; page += 1) {
      const read = await this.deps.postReviewsList.execute(context, {
        ...filters,
        page,
        pageSize: OFFER_POST_REVIEWS_PAGE_MAX,
        paging: 'prev-next',
      });
      if (!read.ok) return read;
      if (read.value.searchCapped) {
        return err({ code: 'validation.failed', fields: [{ path: 'q', code: 'too-broad' }] });
      }
      rows.push(...read.value.items);
      if (!read.value.hasNext) break;
      if (page >= OFFER_POST_REVIEWS_MAX_PAGE) {
        return err({ code: 'batch.too-large', max: OFFER_POST_REVIEWS_EXPORT_MAX_ROWS });
      }
    }
    const day = this.deps.clock.now().toString().slice(0, 10);
    const table: Cell[][] = [[...OFFER_POST_REVIEWS_EXPORT_HEAD], ...rows.map(rowOf)];
    if (format === 'xlsx') {
      return ok({
        filename: `offer-post-reviews-${day}.xlsx`,
        contentType: XLSX_CONTENT_TYPE,
        chunks: this.deps.sheetWriter.xlsx('Offer post-reviews', textRows(table)),
      });
    }
    return ok({
      filename: `offer-post-reviews-${day}.csv`,
      contentType: 'text/csv; charset=utf-8',
      chunks: csvChunks(table),
    });
  }
}

function rowOf(row: AdminOfferPostReviewRow): Cell[] {
  return [
    row.id,
    row.status,
    row.reasons.join('; '),
    row.samplePercent ?? '',
    row.sampleDoubled ? 'yes' : 'no',
    row.offer?.id ?? '',
    row.offer?.status ?? '',
    row.offer === null ? '' : row.offer.listed ? 'yes' : 'no',
    row.offer?.sellerSku ?? '',
    row.product.id,
    row.product.name ?? '',
    row.sellerId,
    row.storeName ?? '',
    row.openedAt,
    row.decidedAt ?? '',
    row.decision?.reasonCode ?? '',
    row.decision?.misconduct === null || row.decision === null
      ? ''
      : row.decision.misconduct
        ? 'yes'
        : 'no',
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
