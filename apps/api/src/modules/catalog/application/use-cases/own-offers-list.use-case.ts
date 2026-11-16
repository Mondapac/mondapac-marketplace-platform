import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT, CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import {
  heldKeys,
  listPage,
  pageWindow,
  parseListQuery as parseSortAndPage,
  rowActions,
  type ListPagingMode,
  type PermissionProbe,
  type RowActionRule,
} from '../../../../platform/list-query';
import type { OfferStatus } from '../../domain/offer';
import type { ProductScope } from '../../domain/product';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import {
  OWN_OFFER_SORTS,
  type OfferStatusCounts,
  type OwnCatalogReader,
  type OwnOfferSort,
  type OwnOffersFilter,
} from '../ports/own-catalog.reader';
import { offerViewOf, type OwnOfferView } from '../own-reads/own-offer-view';
import {
  invalid,
  parsePage,
  sellerOf,
  type ValidationFailure,
} from '../own-reads/own-reads.shared';

export { OWN_OFFER_SORTS };

/** The tabs of the Offer list: each shows the Offers in these statuses. */
export const OWN_OFFER_VIEWS = ['all', 'drafts', 'in-review', 'changes-needed', 'live'] as const;
export type OwnOfferViewTab = (typeof OWN_OFFER_VIEWS)[number];

const LISTED_STATUSES = [
  'draft',
  'pending-first-publish',
  'changes-needed',
  'published',
] as const satisfies readonly OfferStatus[];

const VIEW_STATUSES: Readonly<Record<OwnOfferViewTab, readonly OfferStatus[]>> = Object.freeze({
  all: LISTED_STATUSES,
  drafts: ['draft'],
  'in-review': ['pending-first-publish'],
  'changes-needed': ['changes-needed'],
  live: ['published'],
});

export const OWN_OFFER_PAGE_SIZES = [25, 50, 100] as const;
const DEFAULT_OWN_OFFER_PAGE_SIZE = 25;
/** Page numbers stop here: a row at or past this offset is not reachable (narrow the list). */
export const MAX_OWN_OFFER_ROWS = 10_000;
const SEARCH_MAX_LENGTH = 100;

const LIST_KEYS = new Set<string>([
  'view',
  'q',
  'status',
  'listed',
  'sort',
  'direction',
  'page',
  'pageSize',
  'paging',
]);

export interface OwnOffersListInput {
  /** Keyset mode (no list key given). */
  readonly afterId?: unknown;
  readonly limit?: unknown;
  /** List mode: any of these selects it. `listed` is a boolean (the controller reads `true`/`false`). */
  readonly view?: unknown;
  /** Contained text of the seller SKU, the product code or the product name. */
  readonly q?: unknown;
  readonly status?: unknown;
  readonly listed?: unknown;
  readonly sort?: unknown;
  readonly direction?: unknown;
  readonly page?: unknown;
  readonly pageSize?: unknown;
  /** The Market's "List paging" setting: `pages` (default, with a total) or `prev-next`. */
  readonly paging?: unknown;
}

export interface OwnOffersListOutput {
  readonly items: readonly OwnOfferView[];
  /** The `afterId` of the next page; null on the last page. */
  readonly nextAfterId: string | null;
  /** All the seller's Offers per status, whatever the page. */
  readonly counts: OfferStatusCounts;
}

/** One row of the Offer list with the row actions the caller may run on it. */
export interface OwnOfferListItem extends OwnOfferView {
  /**
   * The row Actions menu: `open`, `edit`, `submit` (a draft), `delete` (a draft or an Offer that
   * needs changes). `prices` and `stock` belong to other modules and are not named here.
   */
  readonly actions: readonly string[];
}

export interface OwnOffersPageOutput {
  readonly items: readonly OwnOfferListItem[];
  /** Over all pages; null in `prev-next` mode (never counted). */
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  readonly hasNext: boolean;
  /** Per status for the same search and on-sale filter (the status filter is not applied). */
  readonly counts: OfferStatusCounts & { readonly all: number };
}

export type OwnOffersListResult = OwnOffersListOutput | OwnOffersPageOutput;

/** What each row action needs: the key its use case checks and the state it can run on. */
export const OWN_OFFER_ACTION_RULES: readonly RowActionRule<
  Pick<OwnOfferView, 'status'> & { readonly productScope: ProductScope | null }
>[] = [
  { id: 'open', permission: null },
  {
    id: 'edit',
    // Only a deleted Offer is not editable, and the list never shows one.
    permission: CATALOG_OWN_PRODUCT_EDIT.key,
  },
  {
    id: 'submit',
    permission: CATALOG_OWN_PRODUCT_EDIT.key,
    when: (row) => row.status === 'draft',
  },
  {
    id: 'delete',
    permission: CATALOG_OWN_PRODUCT_EDIT.key,
    // Same rule as `own-offer.delete`: any open status, but only on a PLATFORM product (an Offer
    // on the seller's own product goes with the product). An unknown scope fails closed.
    when: (row) => row.productScope === 'PLATFORM',
  },
];

const STATUS_KEYS = {
  draft: 'draft',
  'pending-first-publish': 'pendingFirstPublish',
  'changes-needed': 'changesNeeded',
  published: 'published',
} as const;

const countOf = (counts: OfferStatusCounts, status: OfferStatus): number =>
  status in STATUS_KEYS ? counts[STATUS_KEYS[status as keyof typeof STATUS_KEYS]] : 0;

export type OwnOffersListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface OwnOffersListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly ownReader: OwnCatalogReader;
  readonly policy: CatalogMarketPolicy;
  /** The gate's answer to "does the caller hold `catalog.own-product.edit`", for the row actions. */
  readonly ownEditProbe: PermissionProbe;
}

/**
 * `own-offers.list` (catalog design 8.2, 9.2a): the seller's own Offers that are not deleted,
 * each with the label of its product. Two modes. With no list key the keyset mode (`afterId`,
 * `limit`; newest first) answers as it always did. With any list key (`view`, `q`, `status`,
 * `listed`, `sort`, `direction`, `page`, `pageSize`, `paging`) the list mode answers one numbered
 * page with its row actions, the total (not in `prev-next` mode) and the tab counts; the closed
 * query refuses unknown keys, bad values and a page past row 10,000. Rule: the key
 * `catalog.own-product.view` and the seller population; the seller comes from the actor, so
 * another seller's Offer is never read. No price and no stock (other modules own them). One
 * read-only unit (ADR-0025).
 */
export class OwnOffersList extends UseCase<
  OwnOffersListInput,
  OwnOffersListResult,
  OwnOffersListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-offers-list',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnOffersListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOffersListInput,
  ): Promise<Result<OwnOffersListResult, OwnOffersListFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    if (isListMode(input)) return this.list(context, sellerId, input);
    return this.keyset(context, sellerId, input);
  }

  /** The list with views, search, filters, sort, paging, counts and row actions. */
  private async list(
    context: CallContext,
    sellerId: Id<'Seller'>,
    input: OwnOffersListInput,
  ): Promise<Result<OwnOffersPageOutput, OwnOffersListFailure>> {
    const query = parseOfferListQuery(input);
    if (!query.ok) return query;
    const q = query.value;
    const { market } = context;
    let locale: string;
    try {
      locale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const filter: OwnOffersFilter = {
      statuses: VIEW_STATUSES[q.view].filter((status) => q.status === null || status === q.status),
      listed: q.listed,
      text: q.text,
      locale,
    };
    const window = pageWindow(q);
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const reader = this.deps.ownReader;
        // Previous and Next never counts the rows; the tab counts stay (one grouped read).
        const byStatus = await reader.countOffersByStatus(market, sellerId, filter);
        // The total is the tab counts of the selected statuses: no second scan of the search.
        const total =
          q.paging === 'pages'
            ? filter.statuses.reduce((sum, status) => sum + countOf(byStatus, status), 0)
            : null;
        const rows =
          total !== null && window.offset >= total
            ? []
            : await reader.listOfferPage(
                market,
                sellerId,
                filter,
                { sort: q.sort, direction: q.direction },
                window,
              );
        const paged = listPage(rows, q, total);
        const labels = await reader.productLabels(
          market,
          [...new Set(paged.items.map((offer) => offer.state.productId))],
          locale,
        );
        return ok({ byStatus, paged, labels });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const { byStatus, paged, labels } = read.value;
    const labelOf = new Map(labels.map((label) => [label.productId, label]));
    const granted = await heldKeys(context, {
      [CATALOG_OWN_PRODUCT_EDIT.key]: this.deps.ownEditProbe,
    });
    return ok({
      items: paged.items.map((offer): OwnOfferListItem => {
        const label = labelOf.get(offer.state.productId);
        const view = offerViewOf(offer, label);
        return {
          ...view,
          actions: rowActions(
            { ...view, productScope: label?.scope ?? null },
            OWN_OFFER_ACTION_RULES,
            granted,
          ),
        };
      }),
      total: paged.total,
      page: paged.page,
      pageSize: paged.pageSize,
      paging: paged.paging,
      // A page past row 10,000 is refused, so the last page has no Next.
      hasNext: paged.hasNext && paged.page * paged.pageSize < MAX_OWN_OFFER_ROWS,
      counts: {
        ...byStatus,
        all:
          byStatus.draft +
          byStatus.pendingFirstPublish +
          byStatus.changesNeeded +
          byStatus.published,
      },
    });
  }

  /** The keyset list (`afterId`, `limit`): unchanged, for callers that do not send a list key. */
  private async keyset(
    context: CallContext,
    sellerId: Id<'Seller'>,
    input: OwnOffersListInput,
  ): Promise<Result<OwnOffersListOutput, OwnOffersListFailure>> {
    const page = parsePage<'Offer'>(input);
    if (!page.ok) return page;
    const { market } = context;
    let locale: string;
    try {
      locale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const rows = await this.deps.ownReader.listOffers(market, sellerId, {
          afterId: page.value.afterId,
          limit: page.value.limit + 1,
        });
        const shown = rows.slice(0, page.value.limit);
        const labels = await this.deps.ownReader.productLabels(
          market,
          [...new Set(shown.map((offer) => offer.state.productId))],
          locale,
        );
        const counts = await this.deps.ownReader.offerStatusCounts(market, sellerId);
        return ok({ rows, shown, labels, counts });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const { rows, shown, labels, counts } = read.value;
    const labelOf = new Map(labels.map((label) => [label.productId, label]));
    return ok({
      items: shown.map((offer) => offerViewOf(offer, labelOf.get(offer.state.productId))),
      nextAfterId: rows.length > shown.length ? (shown[shown.length - 1]?.state.id ?? null) : null,
      counts,
    });
  }
}

/** List mode when any list key is present; otherwise the keyset mode (so an empty query too). */
function isListMode(input: OwnOffersListInput): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    Object.keys(input).some((key) => LIST_KEYS.has(key))
  );
}

interface ParsedOfferListQuery {
  readonly view: OwnOfferViewTab;
  readonly text: string | null;
  readonly status: OfferStatus | null;
  readonly listed: boolean | null;
  readonly sort: OwnOfferSort;
  readonly direction: 'asc' | 'desc';
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
}

const absent = (value: unknown): boolean => value === undefined || value === null || value === '';

/**
 * The closed query of the list mode: `afterId` and `limit` belong to the keyset mode and are
 * refused here like an unknown key; bad values and out-of-range numbers are refused whole.
 */
export function parseOfferListQuery(
  input: unknown,
): Result<ParsedOfferListQuery, ValidationFailure> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('query', 'type');
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    // The key is the caller's own text: echo no more than 64 characters of it.
    if (!LIST_KEYS.has(key)) return invalid(Array.from(key).slice(0, 64).join(''), 'unknown');
  }
  let view: OwnOfferViewTab = 'all';
  if (!absent(record['view'])) {
    const found = OWN_OFFER_VIEWS.find((candidate) => candidate === record['view']);
    if (found === undefined) return invalid('view', 'value');
    view = found;
  }
  let status: OfferStatus | null = null;
  if (!absent(record['status'])) {
    const found = LISTED_STATUSES.find((candidate) => candidate === record['status']);
    if (found === undefined) return invalid('status', 'value');
    status = found;
  }
  let listed: boolean | null = null;
  if (!absent(record['listed'])) {
    if (typeof record['listed'] !== 'boolean') return invalid('listed', 'value');
    listed = record['listed'];
  }
  let text: string | null = null;
  if (!absent(record['q'])) {
    const value = record['q'];
    if (typeof value !== 'string' || Array.from(value).length > SEARCH_MAX_LENGTH) {
      return invalid('q', 'length');
    }
    // Control characters are never part of a name, a SKU or a code.
    if (/\p{C}/u.test(value)) return invalid('q', 'format');
    text = value.trim() === '' ? null : value.trim();
  }
  if (!absent(record['pageSize'])) {
    const size = record['pageSize'];
    if (typeof size !== 'number' || !(OWN_OFFER_PAGE_SIZES as readonly number[]).includes(size)) {
      return invalid('pageSize', 'range');
    }
  }
  const paged = parseSortAndPage(record, {
    sorts: OWN_OFFER_SORTS,
    defaultSort: 'created',
    defaultDirection: (sort) => (sort === 'sku' ? 'asc' : 'desc'),
    defaultPageSize: DEFAULT_OWN_OFFER_PAGE_SIZE,
    maxPageSize: 100,
    maxPage: MAX_OWN_OFFER_ROWS,
  });
  if (!paged.ok) return paged;
  // Both paging modes stop at row 10,000: past it the seller narrows the list.
  if ((paged.value.page - 1) * paged.value.pageSize >= MAX_OWN_OFFER_ROWS) {
    return invalid('page', 'range');
  }
  return ok({ view, text, status, listed, ...paged.value });
}
