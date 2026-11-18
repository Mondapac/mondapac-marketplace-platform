import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  buildExportFile,
  checkExportSize,
  LIST_EXPORT_MAX_ROWS,
  parseExportColumns,
  parseExportFormat,
  parseExportIds,
  type ExportCell,
  type ExportFile,
  type SheetWriter,
} from '../../../../platform/list-export';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import type { Offer } from '../../domain/offer';
import { invalid, sellerOf, type ValidationFailure } from '../own-reads/own-reads.shared';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OwnCatalogReader, OwnOffersFilter, ProductLabel } from '../ports/own-catalog.reader';
import { countOf, offerFilterOf, parseOfferListQuery } from './own-offers-list.use-case';

/** Offers one export may hold (the shared cap); more is refused whole. */
export const OWN_OFFER_EXPORT_MAX_ROWS = LIST_EXPORT_MAX_ROWS;
/** Selected rows one export may name: one list page at its largest. */
export const OWN_OFFER_EXPORT_MAX_IDS = 100;
/** Offers read per chunk while the file streams. */
const CHUNK = 100;

/** The columns of the seller Offers list, as the page's column chooser names them. */
export const OWN_OFFER_EXPORT_COLUMNS = [
  'sku',
  'product',
  'status',
  'code',
  'listed',
  'created',
  'type',
] as const;
export type OwnOfferExportColumn = (typeof OWN_OFFER_EXPORT_COLUMNS)[number];

/** Always in the file, first and in this order, whatever `columns` says. */
const ALWAYS: readonly OwnOfferExportColumn[] = ['sku', 'product', 'status'];
/** The optional columns used when `columns` is absent. */
const DEFAULT_OPTIONAL: readonly OwnOfferExportColumn[] = ['code', 'listed'];

export const OWN_OFFER_EXPORT_HEADERS: Readonly<Record<OwnOfferExportColumn, string>> =
  Object.freeze({
    sku: 'SKU',
    product: 'Product',
    status: 'Status',
    code: 'Product code',
    listed: 'On sale',
    created: 'Created',
    type: 'Product type',
  });

const STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  draft: 'Draft',
  'pending-first-publish': 'In review',
  'changes-needed': 'Changes needed',
  published: 'Live',
});

export interface OwnOffersExportInput {
  readonly format?: unknown;
  /** Comma-separated column keys, in the order shown. */
  readonly columns?: unknown;
  /** Comma-separated ids of the selected rows; without it the selector picks the Offers. */
  readonly offerIds?: unknown;
  /** The selector of the list: view, q, status, listed, sort, direction. */
  readonly [selectorKey: string]: unknown;
}

export type OwnOffersExportFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'offer.not-found' }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number }
  | ValidationFailure;

export interface OwnOffersExportDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly ownReader: OwnCatalogReader;
  readonly policy: CatalogMarketPolicy;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

type OfferRow = { readonly offer: Offer; readonly label: ProductLabel | undefined };

/** What the first read of an export found. */
type Head =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'too-large'; readonly total: number }
  | {
      readonly kind: 'snapshot';
      /** The matching Offers in file order, read once: the file holds exactly these. */
      readonly ids: readonly Id<'Offer'>[];
      readonly rows: readonly OfferRow[];
    };

const OWN_KEYS = new Set(['format', 'columns', 'offerIds']);

/**
 * `own-offers.export` (super list B1-4, Export on the seller Offers page): the seller's own
 * Offers as a CSV or XLSX file with the columns the page shows. The selector is the list's
 * (`view`, `q`, `status`, `listed`, `sort`, `direction`, read by the list's closed parser; `page`,
 * `pageSize`, `paging`, `afterId` and `limit` belong to the list and are refused), plus `offerIds`
 * (at most {@link OWN_OFFER_EXPORT_MAX_IDS}, comma-separated): the rows the seller selected. With
 * `offerIds` exactly those Offers leave, in the order of `sort`; an id that is no listed Offer of
 * the calling seller refuses the whole request as `offer.not-found` (the same answer for another
 * seller's Offer and an unknown id). Without it the selector picks the Offers, at most
 * {@link OWN_OFFER_EXPORT_MAX_ROWS} (more is `batch.too-large`). `sku`, `product` and `status`
 * are always in the file, first; `columns` adds `code`, `listed`, `created` and `type` after them
 * in the order given (absent: code, listed). Rule: the key `catalog.own-product.view` and the
 * seller population; the seller comes from the actor. The file is built by the shared export, so a
 * CSV text cell that starts with a formula sign gets a leading quote and an XLSX cell is always a
 * string. The matching ids are read first (one more than the cap), and the rows by those ids in
 * read-only units of {@link CHUNK}, so an edit while the file streams can neither move nor
 * repeat a row; the first chunk is read before the answer, so a refusal never arrives after the
 * status line.
 */
export class OwnOffersExport extends UseCase<
  OwnOffersExportInput,
  ExportFile,
  OwnOffersExportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-offers-export',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnOffersExportDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOffersExportInput,
  ): Promise<Result<ExportFile, OwnOffersExportFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('query', 'type');
    }
    const { format: rawFormat, columns: rawColumns, offerIds: rawIds, ...rest } = input;
    for (const key of Object.keys(input)) {
      if (OWN_KEYS.has(key)) continue;
      // The list's paging and the keyset parameters make no sense for a file.
      if (['page', 'pageSize', 'paging', 'afterId', 'limit'].includes(key)) {
        return invalid(key, 'unknown');
      }
    }
    const format = parseExportFormat(rawFormat);
    if (!format.ok) return format;
    const optional = parseExportColumns(rawColumns, OWN_OFFER_EXPORT_COLUMNS);
    if (!optional.ok) return optional;
    const columns: readonly OwnOfferExportColumn[] =
      rawColumns === undefined || rawColumns === ''
        ? [...ALWAYS, ...DEFAULT_OPTIONAL]
        : [...ALWAYS, ...optional.value.filter((column) => !ALWAYS.includes(column))];
    const query = parseOfferListQuery(rest);
    if (!query.ok) return query;
    let ids: readonly Id<'Offer'>[] | null = null;
    if (rawIds !== undefined && rawIds !== '') {
      if (typeof rawIds !== 'string') return invalid('offerIds', 'type');
      const parsed = parseExportIds(rawIds, OWN_OFFER_EXPORT_MAX_IDS, (part) => {
        const id = parseId<'Offer'>(part);
        return id !== null && id.ok ? id.value : null;
      });
      if (!parsed.ok) {
        return parsed.error.code === 'validation.failed'
          ? invalid('offerIds', parsed.error.fields[0]?.code ?? 'format')
          : err(parsed.error);
      }
      ids = parsed.value;
    }

    const { market } = context;
    const { deps } = this;
    let locale: string;
    try {
      locale = deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const filter: OwnOffersFilter =
      ids === null
        ? offerFilterOf(query.value, locale)
        : offerFilterOf({ view: 'all', status: null, listed: null, text: null }, locale, ids);
    const order = { sort: query.value.sort, direction: query.value.direction } as const;

    const first = await deps.unitOfWork.run(
      market,
      async (): Promise<Result<Head, never>> => {
        const found = await deps.ownReader.listOfferIds(
          market,
          sellerId,
          filter,
          order,
          OWN_OFFER_EXPORT_MAX_ROWS + 1,
        );
        if (ids !== null && found.length !== ids.length) return ok({ kind: 'not-found' });
        const size = checkExportSize(found.length);
        if (!size.ok) {
          const counts = await deps.ownReader.countOffersByStatus(market, sellerId, filter);
          const total = filter.statuses.reduce((sum, status) => sum + countOf(counts, status), 0);
          return ok({ kind: 'too-large', total });
        }
        const rows = await this.#read(context, sellerId, found.slice(0, CHUNK), locale);
        return ok({ kind: 'snapshot', ids: found, rows });
      },
      { readOnly: true },
    );
    if (!first.ok) return err({ code: 'access.unavailable' });
    const head = first.value;
    if (head.kind === 'not-found') return err({ code: 'offer.not-found' });
    if (head.kind === 'too-large') {
      return err({
        code: 'batch.too-large',
        max: OWN_OFFER_EXPORT_MAX_ROWS,
        total: head.total,
      });
    }
    return ok(
      buildExportFile({
        format: format.value,
        baseName: 'offers',
        sheetName: 'Offers',
        day: deps.clock.now().toString().slice(0, 10),
        groups: this.#groups(context, sellerId, locale, columns, head.ids, head.rows),
        sheetWriter: deps.sheetWriter,
      }),
    );
  }

  /** The Offers of these ids with the label of each one's product (read inside a unit). */
  async #read(
    context: CallContext,
    sellerId: Id<'Seller'>,
    ids: readonly Id<'Offer'>[],
    locale: string,
  ): Promise<readonly OfferRow[]> {
    const { market } = context;
    const reader = this.deps.ownReader;
    const offers = await reader.listOffersByIds(market, sellerId, ids);
    const labels = await reader.productLabels(
      market,
      [...new Set(offers.map((offer) => offer.state.productId))],
      locale,
    );
    const labelOf = new Map(labels.map((label) => [label.productId, label]));
    return offers.map((offer) => ({ offer, label: labelOf.get(offer.state.productId) }));
  }

  /** The rows of the file, a group per chunk of the snapshot's ids: the header group first. */
  async *#groups(
    context: CallContext,
    sellerId: Id<'Seller'>,
    locale: string,
    columns: readonly OwnOfferExportColumn[],
    snapshot: readonly Id<'Offer'>[],
    firstRows: readonly OfferRow[],
  ): AsyncGenerator<readonly (readonly ExportCell[])[]> {
    const { market } = context;
    yield [columns.map((column) => OWN_OFFER_EXPORT_HEADERS[column])];
    yield firstRows.map((row) => columns.map((column) => cellOf(column, row.offer, row.label)));
    for (let start = CHUNK; start < snapshot.length; start += CHUNK) {
      const read = await this.deps.unitOfWork.run(
        market,
        async () =>
          ok(await this.#read(context, sellerId, snapshot.slice(start, start + CHUNK), locale)),
        { readOnly: true },
      );
      if (!read.ok) throw new Error('catalog.own-offers-export: the read failed');
      // An Offer deleted since the snapshot is absent; the rest keep their place.
      if (read.value.length === 0) continue;
      yield read.value.map((row) => columns.map((column) => cellOf(column, row.offer, row.label)));
    }
  }
}

function cellOf(
  column: OwnOfferExportColumn,
  offer: Offer,
  label: ProductLabel | undefined,
): ExportCell {
  const { state } = offer;
  switch (column) {
    case 'sku':
      return state.sellerSku;
    case 'product':
      return label?.name ?? '';
    case 'status':
      return STATUS_LABELS[state.status] ?? state.status;
    case 'code':
      return label?.productCode ?? '';
    case 'listed':
      return state.listed ? 'Yes' : 'No';
    case 'created':
      return state.createdAt.toString();
    case 'type':
      return label?.typeCode ?? '';
  }
}
