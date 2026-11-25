import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  pageWindow,
  parseListQuery,
  type ListPagingMode,
  type PermissionProbe,
} from '../../../../platform/list-query';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import {
  OFFER_POST_REVIEWS_FILTER_KEYS,
  parsePostReviewFilter,
  postReviewKeys,
  postReviewRows,
  readPostReviewRowFacts,
  type AdminOfferPostReviewRow,
} from '../offer-post-review/post-review-rows';
import type { ValidationFailure } from '../own-reads/own-reads.shared';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferPostReviewFilter, OfferPostReviewRepository } from '../ports/offer-post-review';
import type { OfferRepository } from '../ports/offer.repository';
import type { OwnCatalogReader, QueueTextSearch } from '../ports/own-catalog.reader';
import type { SellerNamesReader } from '../ports/seller-names.reader';
import type { StoreNameSearch } from '../ports/store-name-search';
import {
  queueSellersOf,
  REVIEW_QUEUE_SELLERS_MAX,
  type QueueSeller,
} from './review-queue-list.use-case';

export const OFFER_POST_REVIEWS_SORTS = ['opened', 'decided'] as const;
export const OFFER_POST_REVIEWS_PAGE_DEFAULT = 25;
export const OFFER_POST_REVIEWS_PAGE_MAX = 50;
/** Page numbers stop at 1,000 rows, as the other review lists: a work list, not an archive. */
export const OFFER_POST_REVIEWS_MAX_PAGE = 20;
const PAGE_KEYS = ['sort', 'direction', 'page', 'pageSize', 'paging'] as const;

export interface AdminOfferPostReviewsListOutput {
  readonly items: readonly AdminOfferPostReviewRow[];
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  readonly hasNext: boolean;
  /** The rows the filters keep over every page; null in `prev-next` mode. */
  readonly total: number | null;
  /** Every open row of the Market, whatever the filters (the tab count). */
  readonly totalOpen: number;
  /** The store-name part of `q` matched more stores than can be searched: narrow the search. */
  readonly searchCapped: boolean;
  /** The stores with a row in the status view, whatever the other filters (the seller options). */
  readonly sellers: readonly QueueSeller[];
  readonly sellersCapped: boolean;
}

export type AdminOfferPostReviewsListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface AdminOfferPostReviewsListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly postReviews: OfferPostReviewRepository;
  readonly offers: OfferRepository;
  readonly ownReader: OwnCatalogReader;
  readonly policy: CatalogMarketPolicy;
  readonly sellerNames: SellerNamesReader;
  readonly storeSearch: StoreNameSearch;
  readonly productApproveProbe: PermissionProbe;
  readonly deleteProbe: PermissionProbe;
}

const invalid = (path: string, code: string) =>
  err({ code: 'validation.failed', fields: [{ path, code }] } as const);

const logger = new Logger('AdminOfferPostReviewsList');

/**
 * `catalog.admin-offer-post-reviews-list` (risk-based Offer approval slice 6): the published
 * Offers on the post-publication review list, as a super list (CLAUDE.md rule 14). Filters
 * `status` (`open` default, `approved`, `taken-down`, `all`), `reasons` (any of), `sellerId`,
 * `categoryId` (the product's published revision), `openedFrom`/`openedTo` (the age) and `q` (the
 * review queue's rules and escaping); `sort` `opened` or `decided`, `direction`, `page`,
 * `pageSize`, `paging` from the Market's "List paging" (`total` in pages mode). `totalOpen` is
 * the tab count; `sellers` the seller filter's options. Codes and labels only: no price, no
 * median, never the note. Rule: `catalog.product.view` and the admin population. One read-only
 * unit (ADR-0025); the store-name search runs before it and the names after it.
 */
export class AdminOfferPostReviewsList extends UseCase<
  Record<string, unknown>,
  AdminOfferPostReviewsListOutput,
  AdminOfferPostReviewsListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-offer-post-reviews-list',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminOfferPostReviewsListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Record<string, unknown>,
  ): Promise<Result<AdminOfferPostReviewsListOutput, AdminOfferPostReviewsListFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('query', 'type');
    }
    for (const key of Object.keys(input)) {
      const known =
        (PAGE_KEYS as readonly string[]).includes(key) ||
        (OFFER_POST_REVIEWS_FILTER_KEYS as readonly string[]).includes(key);
      if (!known) return invalid(key, 'unknown');
    }
    const parsed = parsePostReviewFilter(input);
    if (!parsed.ok) return parsed;
    const query = parseListQuery(input, {
      sorts: OFFER_POST_REVIEWS_SORTS,
      defaultSort: 'opened',
      defaultDirection: () => 'asc',
      defaultPageSize: OFFER_POST_REVIEWS_PAGE_DEFAULT,
      maxPageSize: OFFER_POST_REVIEWS_PAGE_MAX,
      maxPage: OFFER_POST_REVIEWS_MAX_PAGE,
    });
    if (!query.ok) return query;
    const { offset, limit } = pageWindow(query.value);

    let locale: string;
    try {
      locale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const { text, ...rest } = parsed.value;
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
          msg: 'catalog.admin-offer-post-reviews-list.store-search-failed',
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
        return err({ code: 'access.unavailable' });
      }
    }
    const filter: OfferPostReviewFilter = { ...rest, ...(search === undefined ? {} : { search }) };
    const pagesMode = query.value.paging === 'pages';
    const { deps } = this;
    const read = await deps.unitOfWork.run(
      market,
      async () => {
        const totalOpen = await deps.postReviews.count(market, { status: 'open' });
        const sellerIds = await deps.postReviews.sellerIds(
          market,
          rest.status,
          REVIEW_QUEUE_SELLERS_MAX + 1,
        );
        const total = pagesMode ? await deps.postReviews.count(market, filter) : null;
        const rows =
          total !== null && offset >= total
            ? []
            : await deps.postReviews.list(
                market,
                { sort: query.value.sort, direction: query.value.direction, offset, limit },
                filter,
              );
        const shown = rows.slice(0, query.value.pageSize);
        const facts = await readPostReviewRowFacts(deps, market, shown, locale);
        return ok({ rows, shown, facts, total, totalOpen, sellerIds });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const { rows, shown, facts, total, totalOpen, sellerIds } = read.value;
    const keys = await postReviewKeys(deps, context);
    const items = await postReviewRows(deps, context, shown, facts, keys);
    const sellers = await queueSellersOf(
      context,
      deps.sellerNames,
      sellerIds.slice(0, REVIEW_QUEUE_SELLERS_MAX),
    );
    const hasNext = pagesMode
      ? offset + query.value.pageSize < (total ?? 0)
      : rows.length > shown.length;
    return ok({
      items,
      page: query.value.page,
      pageSize: query.value.pageSize,
      paging: query.value.paging,
      hasNext,
      total,
      totalOpen,
      searchCapped,
      sellers,
      sellersCapped: sellerIds.length > REVIEW_QUEUE_SELLERS_MAX,
    });
  }
}
