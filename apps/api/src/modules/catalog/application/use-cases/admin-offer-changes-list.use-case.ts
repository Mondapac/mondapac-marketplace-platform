import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  listQueryInvalid,
  pageWindow,
  parseListQuery,
  parseNamedInstantRange,
  type ListPagingMode,
  type PermissionProbe,
} from '../../../../platform/list-query';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import type { OfferReviewReason } from '../../domain/offer-review-policy';
import { parseOfferReviewReasons } from '../offer-changes/review-reasons-filter';
import {
  adminOfferChangeRows,
  readAdminOfferChangeFacts,
  type AdminOfferChangeRow,
} from '../offer-changes/admin-offer-change-rows';
import type { ChangeValidationFailure } from '../offer-change-view';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type {
  OfferChangeQueueFilter,
  OfferPendingChangeRepository,
} from '../ports/offer-pending-change.repository';
import type { OfferRepository } from '../ports/offer.repository';
import type { OwnCatalogReader, QueueTextSearch } from '../ports/own-catalog.reader';
import type { SellerNamesReader } from '../ports/seller-names.reader';
import type { StoreNameSearch } from '../ports/store-name-search';
import {
  parseQueueSearch,
  queueSellersOf,
  REVIEW_QUEUE_SELLERS_MAX,
  type QueueSeller,
} from './review-queue-list.use-case';

export const OFFER_CHANGES_SORTS = ['submitted'] as const;
export const OFFER_CHANGES_PAGE_DEFAULT = 25;
export const OFFER_CHANGES_PAGE_MAX = 50;
/** Page numbers stop at 1,000 rows, as the review queue: a work list, not an archive. */
export const OFFER_CHANGES_MAX_PAGE = 20;

/** The filter keys of the list (and of its export). */
export const OFFER_CHANGES_FILTER_KEYS = [
  'reasons',
  'sellerId',
  'categoryId',
  'submittedFrom',
  'submittedTo',
  'q',
] as const;
const PAGE_KEYS = ['sort', 'direction', 'page', 'pageSize', 'paging'] as const;

export interface AdminOfferChangesListInput {
  /** The `nextAfterId` of the previous page (keyset read; with `limit`, never with page keys). */
  readonly afterId?: unknown;
  /** 1 to 50, default 25 (keyset read). */
  readonly limit?: unknown;
  readonly sort?: unknown;
  readonly direction?: unknown;
  readonly page?: unknown;
  readonly pageSize?: unknown;
  readonly paging?: unknown;
  /** Review reason codes (an array, or one comma-separated text): changes with any of them. */
  readonly reasons?: unknown;
  readonly sellerId?: unknown;
  /** A platform category of the product's published revision. */
  readonly categoryId?: unknown;
  /** Submitted at or after this ISO 8601 instant (inclusive): the age filter. */
  readonly submittedFrom?: unknown;
  /** Submitted before this ISO 8601 instant (exclusive): the age filter ("older than 24 h"). */
  readonly submittedTo?: unknown;
  /** The review queue's search text (2 to 100 characters). */
  readonly q?: unknown;
}

export interface AdminOfferChangesListOutput {
  readonly items: readonly AdminOfferChangeRow[];
  /** The `afterId` of the next page; null on the last page and on a descending read. */
  readonly nextAfterId: string | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  readonly hasNext: boolean;
  /** The changes the filters keep, over every page; null in `prev-next` mode. */
  readonly total: number | null;
  /** Every pending change of the Market, whatever the filters (the tab count). */
  readonly totalPending: number;
  /** The store-name part of `q` matched more stores than `sellers` answers: narrow the search. */
  readonly searchCapped: boolean;
  /** The stores with a pending change, whatever the filters (the seller filter's options). */
  readonly sellers: readonly QueueSeller[];
  /** More stores have a pending change than the options hold (100): the others are not offered. */
  readonly sellersCapped: boolean;
}

export type AdminOfferChangesListFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | ChangeValidationFailure;

export interface AdminOfferChangesListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly pendingChanges: OfferPendingChangeRepository;
  readonly offers: OfferRepository;
  readonly ownReader: OwnCatalogReader;
  readonly policy: CatalogMarketPolicy;
  readonly sellerNames: SellerNamesReader;
  readonly storeSearch: StoreNameSearch;
  readonly productApproveProbe: PermissionProbe;
}

const invalid = (path: string, code: string) =>
  err({ code: 'validation.failed', fields: [{ path, code }] } as const);

interface ParsedFilter {
  readonly reasons?: readonly OfferReviewReason[];
  readonly sellerId?: Id<'Seller'>;
  readonly categoryId?: Id<'Category'>;
  readonly submittedFrom: OfferChangeQueueFilter['submittedFrom'];
  readonly submittedTo: OfferChangeQueueFilter['submittedTo'];
  readonly text: string | null;
}

const absent = (value: unknown): boolean => value === undefined || value === null || value === '';

function parseFilter(
  record: Readonly<Record<string, unknown>>,
): Result<ParsedFilter, ChangeValidationFailure> {
  const reasons = parseOfferReviewReasons(record['reasons']);
  if (!reasons.ok) return reasons;
  const ids: { sellerId?: Id<'Seller'>; categoryId?: Id<'Category'> } = {};
  for (const key of ['sellerId', 'categoryId'] as const) {
    if (absent(record[key])) continue;
    const parsed = typeof record[key] === 'string' ? parseId(record[key]) : null;
    if (parsed === null || !parsed.ok) return invalid(key, 'format');
    (ids as Record<string, unknown>)[key] = parsed.value;
  }
  const submitted = parseNamedInstantRange(record, 'submittedFrom', 'submittedTo');
  if (!submitted.ok) return submitted;
  const text = parseQueueSearch(record['q']);
  if (!text.ok) return text;
  return ok({
    ...(reasons.value === null ? {} : { reasons: reasons.value }),
    ...ids,
    submittedFrom: submitted.value.from,
    submittedTo: submitted.value.to,
    text: text.value,
  });
}

const logger = new Logger('AdminOfferChangesList');

/**
 * `admin-offer-changes.list` (risk-based Offer approval slices 2c and 5): the held changes of live
 * Offers that wait for a decision, as a super list (CLAUDE.md rule 14). Filters `reasons` (any of),
 * `sellerId`, `categoryId` (the product's published revision), `submittedFrom`/`submittedTo` (the
 * age) and `q` (the review queue's rules: product code, published product name in the Market's
 * default locale, or a store name matched by `sellers` first). Two reads: the keyset read of slice
 * 2c (`afterId`, `limit`; oldest first) and the page read (`sort` `submitted`, `direction`,
 * `page`, `pageSize`, `paging` from the Market's "List paging" setting), never mixed. `total`
 * counts what the filters keep (pages mode), `totalPending` the whole queue. Each row carries the
 * live Offer's description, handling and tag types next to the proposed ones, the store name, the
 * product label and the caller's actions. Rule: `catalog.product.view` and the admin population.
 * One read-only unit (ADR-0025); the store-name search runs before it and the names after it.
 */
export class AdminOfferChangesList extends UseCase<
  AdminOfferChangesListInput,
  AdminOfferChangesListOutput,
  AdminOfferChangesListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-offer-changes-list',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminOfferChangesListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AdminOfferChangesListInput,
  ): Promise<Result<AdminOfferChangesListOutput, AdminOfferChangesListFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('query', 'type');
    }
    const record = input as Readonly<Record<string, unknown>>;
    for (const key of Object.keys(record)) {
      const known =
        key === 'afterId' ||
        key === 'limit' ||
        (PAGE_KEYS as readonly string[]).includes(key) ||
        (OFFER_CHANGES_FILTER_KEYS as readonly string[]).includes(key);
      if (!known) return invalid(key, 'unknown');
    }
    const cursorMode = !absent(record['afterId']) || !absent(record['limit']);
    if (cursorMode) {
      const mixed = PAGE_KEYS.find((key) => record[key] !== undefined);
      if (mixed !== undefined) return listQueryInvalid(mixed, 'conflict');
    }
    const filter = parseFilter(record);
    if (!filter.ok) return filter;

    let limit: number;
    let offset = 0;
    let direction: 'asc' | 'desc' = 'asc';
    let afterId: Id<'OfferPendingChange'> | null = null;
    let paged: { page: number; pageSize: number; paging: ListPagingMode } | null = null;
    if (cursorMode) {
      const rawLimit = record['limit'] ?? OFFER_CHANGES_PAGE_DEFAULT;
      if (
        typeof rawLimit !== 'number' ||
        !Number.isInteger(rawLimit) ||
        rawLimit < 1 ||
        rawLimit > OFFER_CHANGES_PAGE_MAX
      ) {
        return invalid('limit', 'range');
      }
      limit = rawLimit;
      if (!absent(record['afterId'])) {
        const parsed =
          typeof record['afterId'] === 'string'
            ? parseId<'OfferPendingChange'>(record['afterId'])
            : null;
        if (parsed === null || !parsed.ok) return invalid('afterId', 'format');
        afterId = parsed.value;
      }
    } else {
      const query = parseListQuery(record, {
        sorts: OFFER_CHANGES_SORTS,
        defaultSort: 'submitted',
        defaultDirection: () => 'asc',
        defaultPageSize: OFFER_CHANGES_PAGE_DEFAULT,
        maxPageSize: OFFER_CHANGES_PAGE_MAX,
        maxPage: OFFER_CHANGES_MAX_PAGE,
      });
      if (!query.ok) return query;
      const window = pageWindow(query.value);
      offset = window.offset;
      limit = window.limit;
      direction = query.value.direction;
      paged = query.value;
    }

    let locale: string;
    try {
      locale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const { text, ...rest } = filter.value;
    let search: QueueTextSearch | undefined;
    let searchCapped = false;
    if (text !== null) {
      try {
        const stores = await this.deps.storeSearch.sellersMatching(context, text);
        search = { text, locale, sellerIds: stores.sellerIds };
        searchCapped = stores.capped;
      } catch {
        // Never log the text or the error (it may carry the text).
        logger.warn({
          msg: 'catalog.admin-offer-changes-list.store-search-failed',
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
        return err({ code: 'access.unavailable' });
      }
    }
    const queueFilter: OfferChangeQueueFilter = {
      ...rest,
      ...(search === undefined ? {} : { search }),
    };
    const filtered =
      rest.reasons !== undefined ||
      rest.sellerId !== undefined ||
      rest.categoryId !== undefined ||
      (rest.submittedFrom ?? null) !== null ||
      (rest.submittedTo ?? null) !== null ||
      search !== undefined;
    const pagesMode = paged !== null && paged.paging === 'pages';
    const { deps } = this;
    const read = await deps.unitOfWork.run(
      market,
      async () => {
        let after = null;
        if (afterId !== null) {
          const anchor = await deps.pendingChanges.findById(market, afterId);
          if (anchor === null) return ok(null);
          after = { submittedAt: anchor.state.submittedAt, id: anchor.state.id };
        }
        const totalPending = await deps.pendingChanges.countPending(market);
        const sellerIds = await deps.pendingChanges.pendingSellerIds(
          market,
          REVIEW_QUEUE_SELLERS_MAX + 1,
        );
        const total = !pagesMode
          ? null
          : filtered
            ? await deps.pendingChanges.countPending(market, queueFilter)
            : totalPending;
        // A keyset read takes one extra row to tell whether a next page exists; `pageWindow`
        // already adds it in prev-next mode.
        const rows =
          pagesMode && total !== null && offset >= total
            ? []
            : await deps.pendingChanges.listPending(
                market,
                {
                  after,
                  limit: cursorMode ? limit + 1 : limit,
                  ...(offset === 0 ? {} : { offset }),
                  direction,
                },
                queueFilter,
              );
        const pageSize = paged === null ? limit : paged.pageSize;
        const shown = rows.slice(0, pageSize);
        const facts = await readAdminOfferChangeFacts(deps, market, shown, locale);
        return ok({ rows, shown, facts, total, totalPending, sellerIds });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return invalid('afterId', 'unknown');
    const { rows, shown, facts, total, totalPending, sellerIds } = read.value;
    const items = await adminOfferChangeRows(deps, context, shown, facts);
    const sellersCapped = sellerIds.length > REVIEW_QUEUE_SELLERS_MAX;
    const sellers = await queueSellersOf(
      context,
      deps.sellerNames,
      sellerIds.slice(0, REVIEW_QUEUE_SELLERS_MAX),
    );
    const hasMore = rows.length > shown.length;
    const last = shown[shown.length - 1];
    if (paged === null) {
      return ok({
        items,
        nextAfterId: hasMore && last !== undefined ? last.state.id : null,
        page: 1,
        pageSize: limit,
        paging: 'prev-next',
        hasNext: hasMore,
        total: null,
        totalPending,
        searchCapped,
        sellers,
        sellersCapped,
      });
    }
    const hasNext = pagesMode ? offset + paged.pageSize < (total ?? 0) : hasMore;
    return ok({
      items,
      nextAfterId: direction === 'asc' && hasNext && last !== undefined ? last.state.id : null,
      page: paged.page,
      pageSize: paged.pageSize,
      paging: paged.paging,
      hasNext,
      total,
      totalPending,
      searchCapped,
      sellers,
      sellersCapped,
    });
  }
}
