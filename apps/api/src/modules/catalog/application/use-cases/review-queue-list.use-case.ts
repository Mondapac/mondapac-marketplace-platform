import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  heldKeys,
  listQueryInvalid,
  pageWindow,
  parseListQuery,
  rowActions,
  type ListPagingMode,
  type PermissionProbe,
  type RowActionRule,
} from '../../../../platform/list-query';
import { CATALOG_PRODUCT_APPROVE, CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import type { OfferHandling } from '../../domain/offer';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferRepository } from '../ports/offer.repository';
import type { OwnCatalogReader } from '../ports/own-catalog.reader';
import type { VariantGtinRegistry } from '../ports/variant-gtin.registry';
import type { SellerNamesReader } from '../ports/seller-names.reader';
import { requiredChecksOf } from '../revisions/review-checks';
import { invalid, parsePage, isoOf, type ValidationFailure } from '../own-reads/own-reads.shared';

export const REVIEW_QUEUE_SORTS = ['submitted'] as const;
export const REVIEW_QUEUE_PAGE_DEFAULT = 25;
export const REVIEW_QUEUE_PAGE_MAX = 50;
/** Page numbers stop at 1,000 rows: the queue is a work list, and the merge of two sources is in memory. */
export const REVIEW_QUEUE_MAX_PAGE = 20;
/** The most rows read from each source for one descending page. */
const DESC_MAX_ROWS = 1000;

/** What each row action needs: the approve key (the single decisions check it again). */
export const REVIEW_ROW_ACTION_RULES: readonly RowActionRule<unknown>[] = [
  { id: 'approve', permission: CATALOG_PRODUCT_APPROVE.key },
  { id: 'request-changes', permission: CATALOG_PRODUCT_APPROVE.key },
];

export interface ReviewQueueListInput {
  readonly sort?: unknown;
  readonly direction?: unknown;
  readonly page?: unknown;
  readonly pageSize?: unknown;
  readonly paging?: unknown;
  readonly afterId?: unknown;
  readonly limit?: unknown;
  /** `product-revision` or `offer-first-publication`: one kind of row only. */
  readonly kind?: unknown;
  /** One seller's rows only. */
  readonly sellerId?: unknown;
  /** Product revisions only: a first publication (true) or an update (false). */
  readonly firstPublication?: unknown;
  /** Product revisions only: the pending revision has a photo (true) or none (false). */
  readonly hasImages?: unknown;
}

/** The two kinds of row in the queue. */
export const REVIEW_QUEUE_KINDS = ['product-revision', 'offer-first-publication'] as const;
export type ReviewQueueKind = (typeof REVIEW_QUEUE_KINDS)[number];

/** One Offer waiting for its first publication (catalog design 9.2 `review-queue.list`). */
export interface OfferReviewRow {
  readonly kind: 'offer-first-publication';
  readonly offerId: string;
  /** The version a decision must name. */
  readonly version: number;
  readonly sellerId: string;
  /** The seller's public store name; null when `sellers` cannot say. */
  readonly storeName: string | null;
  readonly productId: string;
  readonly product: {
    readonly productCode: string | null;
    readonly typeCode: string | null;
    readonly name: string | null;
  };
  readonly sellerSku: string;
  readonly conditionCode: string;
  readonly description: Readonly<Record<string, string>>;
  readonly handling: OfferHandling | null;
  /** The instant the seller submitted; the queue is oldest first. */
  readonly submittedAt: string | null;
  /** The row actions of the Actions menu the caller may run: `approve`, `request-changes`. */
  readonly actions: readonly string[];
}

/** One seller product whose pending revision waits for a decision (design 8.2, 9.2 item 8). */
export interface ProductRevisionReviewRow {
  readonly kind: 'product-revision';
  readonly productId: string;
  /** The pending revision a decision must name. */
  readonly revisionId: string;
  readonly revisionNo: number;
  /** The product version a decision must name. */
  readonly version: number;
  readonly sellerId: string;
  readonly storeName: string | null;
  readonly product: {
    readonly productCode: string;
    readonly typeCode: string;
    /** The pending revision's name, default locale. */
    readonly name: string | null;
  };
  readonly firstPublication: boolean;
  /** What changed, as classification codes (design 4.3). */
  readonly reasons: readonly string[];
  /** The named checks an approval must confirm (design 8.3a), derived by the server. */
  readonly requiredChecks: readonly string[];
  readonly hasImages: boolean;
  /**
   * Warnings for the reviewer (V4): `gtin.duplicate-platform` when a GTIN of the revision is already
   * carried by a published PLATFORM product (the seller can sell on it), `gtin.duplicate` when it is
   * carried by any other product. Advice only; it never blocks a decision.
   */
  readonly warnings: readonly string[];
  readonly submittedAt: string;
  /** The row actions of the Actions menu the caller may run: `approve`, `request-changes`. */
  readonly actions: readonly string[];
}

export type ReviewQueueRow = OfferReviewRow | ProductRevisionReviewRow;

export interface ReviewQueueListOutput {
  readonly items: readonly ReviewQueueRow[];
  /** The `afterId` of the next page; null on the last page (and on a descending read). */
  readonly nextAfterId: string | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  readonly hasNext: boolean;
  /** The rows the filters keep, over every page. With no filter, the whole queue; null in `prev-next` mode. */
  readonly total: number | null;
  /** Every row of each kind in the Market's queue, whatever the filters (the tab counts). */
  readonly totals: Readonly<Record<ReviewQueueKind, number>>;
}

export type ReviewQueueListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface ReviewQueueListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly ownReader: OwnCatalogReader;
  readonly policy: CatalogMarketPolicy;
  readonly sellerNames: SellerNamesReader;
  readonly gtinRegistry: VariantGtinRegistry;
  readonly productApproveProbe: PermissionProbe;
}

interface Position {
  readonly submittedAt: Temporal.Instant;
  readonly id: string;
}

/** The most rows a source gives in one call (the revision reader clamps its page at 100). */
const SOURCE_CHUNK = 100;

/** Reads `count` rows of one source, oldest first, in calls of at most {@link SOURCE_CHUNK}. */
export async function readChunks<T>(
  read: (after: Position | null, take: number) => Promise<readonly T[]>,
  positionOf: (row: T) => Position,
  start: Position | null,
  count: number,
): Promise<T[]> {
  const rows: T[] = [];
  let after = start;
  while (rows.length < count) {
    const take = Math.min(SOURCE_CHUNK, count - rows.length);
    const chunk = await read(after, take);
    rows.push(...chunk);
    const last = chunk[chunk.length - 1];
    if (chunk.length < take || last === undefined) break;
    after = positionOf(last);
  }
  return rows;
}

const CURSOR = /^(\d{1,15})_([0-9a-f-]{36})$/;

interface QueueFilter {
  readonly kind: ReviewQueueKind | null;
  readonly sellerId?: Id<'Seller'>;
  readonly firstPublication?: boolean;
  readonly hasImages?: boolean;
}

const FILTER_KEYS = ['kind', 'sellerId', 'firstPublication', 'hasImages'] as const;

/**
 * The filters of the queue. `firstPublication` and `hasImages` are product revision fields: given,
 * they keep revisions only, and asking them of Offers is refused.
 */
function parseFilter(record: Record<string, unknown>): Result<QueueFilter, ValidationFailure> {
  const kind = record['kind'];
  if (
    kind !== undefined &&
    (typeof kind !== 'string' || !(REVIEW_QUEUE_KINDS as readonly string[]).includes(kind))
  ) {
    return invalid('kind', 'unknown');
  }
  let sellerId: Id<'Seller'> | undefined;
  if (record['sellerId'] !== undefined) {
    const parsed =
      typeof record['sellerId'] === 'string' ? parseId<'Seller'>(record['sellerId']) : null;
    if (parsed === null || !parsed.ok) return invalid('sellerId', 'format');
    sellerId = parsed.value;
  }
  const flags: { firstPublication?: boolean; hasImages?: boolean } = {};
  for (const key of ['firstPublication', 'hasImages'] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return invalid(key, 'type');
    if (kind === 'offer-first-publication') return invalid(key, 'not-allowed');
    flags[key] = value;
  }
  return ok({
    kind: (kind as ReviewQueueKind | undefined) ?? null,
    ...(sellerId === undefined ? {} : { sellerId }),
    ...flags,
  });
}

/** The cursor of a page: the submit instant (ms) and id of its last row. */
const cursorOf = (position: Position): string =>
  `${position.submittedAt.epochMilliseconds}_${position.id}`;

function parseCursor(value: unknown): Result<Position | null, ValidationFailure> {
  if (value === undefined || value === null) return ok(null);
  const match = typeof value === 'string' ? CURSOR.exec(value) : null;
  const id = match?.[2] === undefined ? null : parseId(match[2]);
  if (match === null || id === null || !id.ok) return invalid('afterId', 'format');
  return ok({
    submittedAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])),
    id: id.value,
  });
}

/**
 * `review-queue.list` (catalog design 8.2, 9.2): what waits for a reviewer, oldest submit first
 * (then by id), keyset-paged: Offers waiting for their first publication and seller products with
 * a pending revision, in one list. Each row carries its `kind`, the seller's public store name
 * (`sellerSummaries`; absent when `sellers` cannot say) and the label of its product; a product
 * revision row also carries what changed and the checks an approval must confirm. Rule: the key
 * `catalog.product.view` and the admin population. `afterId` is the opaque `nextAfterId` of the
 * previous page; the filters (`kind`, `sellerId`, and for revisions `firstPublication` and
 * `hasImages`) keep the same order, so a cursor stays valid under the same filters. `total` counts
 * what the filters keep, `totals` the whole queue per kind. One read-only unit (ADR-0025); the store-name call follows it.
 */
export class ReviewQueueList extends UseCase<
  ReviewQueueListInput,
  ReviewQueueListOutput,
  ReviewQueueListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.review-queue-list',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewQueueListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ReviewQueueListInput,
  ): Promise<Result<ReviewQueueListOutput, ReviewQueueListFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const record: Record<string, unknown> =
      typeof input === 'object' && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const present = (key: string): boolean =>
      record[key] !== undefined && record[key] !== null && record[key] !== '';
    // The older cursor read (`afterId`, `limit`) stays for the current panel; it cannot be mixed
    // with the page keys. Every other call is a page read.
    const PAGE_KEYS = ['sort', 'direction', 'page', 'pageSize', 'paging'] as const;
    const cursorMode = present('afterId') || present('limit');
    if (cursorMode) {
      const mixed = PAGE_KEYS.find((key) => record[key] !== undefined);
      if (mixed !== undefined) return listQueryInvalid(mixed, 'conflict');
    }
    const filter = parseFilter(record);
    if (!filter.ok) return filter;
    let cursor: Position | null = null;
    let limit: number;
    let offset = 0;
    let descending = false;
    let paged: ReturnType<typeof parseListQuery<'submitted'>> | null = null;
    if (cursorMode) {
      const parsedCursor = parseCursor(record['afterId']);
      if (!parsedCursor.ok) return parsedCursor;
      cursor = parsedCursor.value;
      const pageInput = Object.fromEntries(
        Object.entries(record).filter(
          ([key]) => key !== 'afterId' && !(FILTER_KEYS as readonly string[]).includes(key),
        ),
      );
      const page = parsePage<'Offer'>(pageInput);
      if (!page.ok) return page;
      limit = page.value.limit;
    } else {
      const pageInput = Object.fromEntries(
        Object.entries(record).filter(([key]) => !(FILTER_KEYS as readonly string[]).includes(key)),
      );
      const unknownKey = Object.keys(pageInput).find(
        (key) => !(PAGE_KEYS as readonly string[]).includes(key),
      );
      if (unknownKey !== undefined) return invalid(unknownKey, 'unknown');
      paged = parseListQuery(pageInput, {
        sorts: REVIEW_QUEUE_SORTS,
        defaultSort: 'submitted',
        defaultDirection: () => 'asc',
        defaultPageSize: REVIEW_QUEUE_PAGE_DEFAULT,
        maxPageSize: REVIEW_QUEUE_PAGE_MAX,
        maxPage: REVIEW_QUEUE_MAX_PAGE,
      });
      if (!paged.ok) return paged;
      const window = pageWindow(paged.value);
      offset = window.offset;
      limit = window.limit;
      descending = paged.value.direction === 'desc';
    }
    const after = cursor;
    const { kind, sellerId, firstPublication, hasImages } = filter.value;
    const revisionOnly = firstPublication !== undefined || hasImages !== undefined;
    const withOffers = kind !== 'product-revision' && !revisionOnly;
    const withRevisions = kind !== 'offer-first-publication';
    const offerFilter = sellerId === undefined ? {} : { sellerId };
    const revisionFilter = {
      ...offerFilter,
      ...(firstPublication === undefined ? {} : { firstPublication }),
      ...(hasImages === undefined ? {} : { hasImages }),
    };
    let locale: string;
    try {
      locale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const pagesMode = paged !== null && paged.value.paging === 'pages';
    const pageSize = paged === null ? limit : paged.value.pageSize;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const totals = {
          'product-revision': await this.deps.ownReader.pendingRevisionCount(market),
          'offer-first-publication': await this.deps.ownReader.pendingReviewCount(market),
        };
        const filtered = sellerId !== undefined || revisionOnly;
        const offerTotal = withOffers
          ? filtered
            ? await this.deps.ownReader.pendingReviewCount(market, offerFilter)
            : totals['offer-first-publication']
          : 0;
        const revisionTotal = withRevisions
          ? filtered
            ? await this.deps.ownReader.pendingRevisionCount(market, revisionFilter)
            : totals['product-revision']
          : 0;
        const total = offerTotal + revisionTotal;
        // A descending page reads every row of each source (the sources only walk oldest first).
        if (descending && (offerTotal > DESC_MAX_ROWS || revisionTotal > DESC_MAX_ROWS)) {
          return err({
            code: 'validation.failed' as const,
            fields: [{ path: 'direction', code: 'range' }],
          });
        }
        const fetchCount = cursorMode ? limit + 1 : descending ? DESC_MAX_ROWS : offset + limit;
        const offers =
          withOffers && !(pagesMode && offset >= total)
            ? await readChunks(
                (position, take) =>
                  this.deps.offers.listPendingReview(
                    market,
                    { after: position, limit: take },
                    offerFilter,
                  ),
                (offer) => ({
                  submittedAt: offer.state.submittedAt ?? Temporal.Instant.fromEpochMilliseconds(0),
                  id: offer.state.id,
                }),
                after,
                fetchCount,
              )
            : [];
        const revisions =
          withRevisions && !(pagesMode && offset >= total)
            ? await readChunks(
                (position, take) =>
                  this.deps.ownReader.listPendingRevisions(
                    market,
                    { after: position, limit: take },
                    locale,
                    revisionFilter,
                  ),
                (row) => ({ submittedAt: row.submittedAt, id: row.productId }),
                after,
                fetchCount,
              )
            : [];
        // Merge the two sources into one order: submit instant, then id.
        const ordered = [
          ...offers.map((offer) => ({
            kind: 'offer' as const,
            at: offer.state.submittedAt?.epochMilliseconds ?? 0,
            position: {
              submittedAt: offer.state.submittedAt ?? Temporal.Instant.fromEpochMilliseconds(0),
              id: offer.state.id,
            },
            offer,
          })),
          ...revisions.map((row) => ({
            kind: 'revision' as const,
            at: row.submittedAt.epochMilliseconds,
            position: { submittedAt: row.submittedAt, id: row.productId },
            row,
          })),
        ].sort((a, b) => a.at - b.at || (a.position.id < b.position.id ? -1 : 1));
        const merged = descending ? ordered.reverse() : ordered;
        const found = cursorMode ? merged : merged.slice(offset, offset + limit);
        const shown = found.slice(0, pageSize);
        const labels = await this.deps.ownReader.productLabels(
          market,
          [
            ...new Set(
              shown.flatMap((entry) =>
                entry.kind === 'offer' ? [entry.offer.state.productId] : [],
              ),
            ),
          ],
          locale,
        );
        const warnings = new Map<string, readonly string[]>();
        for (const entry of shown) {
          if (entry.kind !== 'revision') continue;
          const { row } = entry;
          const duplicates =
            row.variantGtins.length === 0
              ? []
              : await this.deps.gtinRegistry.duplicatesOf(market, row.productId, [
                  ...new Set(row.variantGtins),
                ]);
          warnings.set(
            row.revisionId,
            duplicates.length === 0
              ? []
              : [
                  duplicates.some((d) => d.scope === 'PLATFORM')
                    ? 'gtin.duplicate-platform'
                    : 'gtin.duplicate',
                ],
          );
        }
        return ok({ found, shown, labels, total, totals, warnings });
      },
      { readOnly: true },
    );
    if (!read.ok) {
      return read.error.code === 'validation.failed' ? read : err({ code: 'access.unavailable' });
    }
    const { found, shown, labels, total, totals, warnings } = read.value;
    const labelOf = new Map(labels.map((label) => [label.productId, label]));
    const last = shown[shown.length - 1];
    const granted = await heldKeys(context, {
      [CATALOG_PRODUCT_APPROVE.key]: this.deps.productApproveProbe,
    });
    const actions = rowActions({}, REVIEW_ROW_ACTION_RULES, granted);

    const names = await this.deps.sellerNames.storeNames(context, [
      ...new Set(
        shown.map((entry) =>
          entry.kind === 'offer' ? entry.offer.state.sellerId : entry.row.sellerId,
        ),
      ),
    ] as Id<'Seller'>[]);

    const items = shown.map((entry): ReviewQueueRow => {
      if (entry.kind === 'revision') {
        const { row } = entry;
        return {
          kind: 'product-revision',
          productId: row.productId,
          revisionId: row.revisionId,
          revisionNo: row.revisionNo,
          version: row.productVersion,
          sellerId: row.sellerId,
          storeName: names.get(row.sellerId) ?? null,
          product: { productCode: row.productCode, typeCode: row.typeCode, name: row.name },
          firstPublication: row.firstPublication,
          reasons: row.sensitiveReasons,
          requiredChecks: requiredChecksOf({
            firstPublication: row.firstPublication,
            reasons: row.sensitiveReasons,
          }),
          hasImages: row.hasImages,
          warnings: warnings.get(row.revisionId) ?? [],
          submittedAt: row.submittedAt.toString(),
          actions,
        };
      }
      const { state } = entry.offer;
      const label = labelOf.get(state.productId);
      return {
        kind: 'offer-first-publication',
        offerId: state.id,
        version: state.version,
        sellerId: state.sellerId,
        storeName: names.get(state.sellerId) ?? null,
        productId: state.productId,
        product: {
          productCode: label?.productCode ?? null,
          typeCode: label?.typeCode ?? null,
          name: label?.name ?? null,
        },
        sellerSku: state.sellerSku,
        conditionCode: state.conditionCode,
        description: state.description,
        handling: state.handling,
        submittedAt: isoOf(state.submittedAt),
        actions,
      };
    });
    const hasMore = found.length > shown.length;
    if (paged === null) {
      return ok({
        items,
        nextAfterId: hasMore && last !== undefined ? cursorOf(last.position) : null,
        page: 1,
        pageSize: limit,
        paging: 'prev-next',
        hasNext: hasMore,
        total,
        totals,
      });
    }
    const hasNext = pagesMode ? offset + pageSize < total : hasMore;
    return ok({
      items,
      // The current panel walks the default order by cursor; a descending read has none.
      nextAfterId: !descending && hasNext && last !== undefined ? cursorOf(last.position) : null,
      page: paged.value.page,
      pageSize,
      paging: paged.value.paging,
      hasNext,
      total: pagesMode ? total : null,
      totals,
    });
  }
}
