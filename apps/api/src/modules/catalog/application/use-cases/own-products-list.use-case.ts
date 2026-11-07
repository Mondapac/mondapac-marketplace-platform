import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import type { ProductStatus } from '../../domain/product';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import {
  OWN_PRODUCT_SORTS,
  type OwnCatalogReader,
  type OwnProductSort,
  type OwnProductsFilter,
  type OwnSortDirection,
} from '../ports/own-catalog.reader';
import {
  invalid,
  isoOf,
  parsePage,
  sellerOf,
  type ValidationFailure,
} from '../own-reads/own-reads.shared';

export { OWN_PRODUCT_SORTS };

/**
 * The statuses the seller's reader returns (discarded and withdrawn are never listed). A product
 * of any other status is not the seller's to see in this list.
 */
export const OWN_LISTED_STATUSES = [
  'draft',
  'unpublished',
  'published',
  'matched',
  'retired',
] as const satisfies readonly ProductStatus[];

/** The tabs of the list (see {@link VIEW_RULES}); `in-review` overlaps the others. */
export const OWN_PRODUCT_VIEWS = ['all', 'drafts', 'live', 'inactive', 'in-review'] as const;
export type OwnProductView = (typeof OWN_PRODUCT_VIEWS)[number];

/**
 * What each tab shows: Drafts is `draft`; Live is `published` or `matched` (a paused product stays
 * Live and carries `pausedAt`); Inactive is `unpublished` or `retired`; In review is every listed
 * status with a pending revision, so it overlaps the other tabs and the counts need not sum.
 */
export const VIEW_RULES: Readonly<
  Record<OwnProductView, { statuses: readonly ProductStatus[]; inReview: boolean }>
> = Object.freeze({
  all: { statuses: OWN_LISTED_STATUSES, inReview: false },
  drafts: { statuses: ['draft'], inReview: false },
  live: { statuses: ['published', 'matched'], inReview: false },
  inactive: { statuses: ['unpublished', 'retired'], inReview: false },
  'in-review': { statuses: OWN_LISTED_STATUSES, inReview: true },
});

export const OWN_PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_OWN_PAGE_SIZE = 25;
/** Page numbers stop here: a row at or past this offset is not reachable (narrow the list). */
export const MAX_OWN_LIST_ROWS = 10_000;
export const SEARCH_MAX_LENGTH = 100;

const LIST_KEYS = [
  'view',
  'q',
  'status',
  'categoryId',
  'paused',
  'typeCode',
  'sort',
  'direction',
  'page',
  'pageSize',
] as const;
const LIST_KEY_SET = new Set<string>(LIST_KEYS);
const TYPE_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface OwnProductsListInput {
  /** Keyset mode (no list key given). */
  readonly afterId?: unknown;
  readonly limit?: unknown;
  /** List mode: any of these selects it. `paused` is a boolean (the controller reads `true`/`false`). */
  readonly view?: unknown;
  readonly q?: unknown;
  readonly status?: unknown;
  readonly categoryId?: unknown;
  readonly paused?: unknown;
  readonly typeCode?: unknown;
  readonly sort?: unknown;
  readonly direction?: unknown;
  readonly page?: unknown;
  readonly pageSize?: unknown;
}

export interface OwnProductListItem {
  readonly productId: string;
  readonly productCode: string;
  readonly typeCode: string;
  readonly status: ProductStatus;
  /** The draft name in the Market's default locale, else null. */
  readonly draftName: string | null;
  readonly hasPublishedRevision: boolean;
  readonly hasPendingRevision: boolean;
  readonly pendingSubmittedAt: string | null;
  readonly lastChangedAt: string;
  readonly createdAt: string;
}

export interface OwnProductsListOutput {
  readonly items: readonly OwnProductListItem[];
  /** The `afterId` of the next page; null on the last page. */
  readonly nextAfterId: string | null;
}

export interface OwnProductPageItem extends OwnProductListItem {
  /** The name shown: the draft's in the Market's default locale, else the shown revision's. */
  readonly name: string | null;
  /** The thumbnail: serve it with `GET catalog/seller/products/{productId}/images/{id}/thumb`. */
  readonly primaryImageId: string | null;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  /** The seller's own Offers on the product that are not deleted. */
  readonly offerCount: number;
  /** Set while the product is paused (it stays in the Live view). */
  readonly pausedAt: string | null;
}

export interface OwnProductViewCounts {
  readonly all: number;
  readonly drafts: number;
  readonly live: number;
  readonly inactive: number;
  readonly inReview: number;
}

export interface OwnProductsPageOutput {
  readonly items: readonly OwnProductPageItem[];
  /** Products matching the view and the filters, over all pages. */
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  /** Per tab, for the same search and filters (the status filter included). */
  readonly counts: OwnProductViewCounts;
}

export type OwnProductsListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export type OwnProductsListResult = OwnProductsListOutput | OwnProductsPageOutput;

export interface OwnProductsListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly ownReader: OwnCatalogReader;
  readonly policy: CatalogMarketPolicy;
}

/**
 * `own-products.list` (catalog design 8.2, 9.2a): the seller's own SELLER products. Two modes. With
 * no list key the keyset mode (`afterId`, `limit`; newest first) answers as it always did. With any
 * list key (`view`, `q`, `status`, `categoryId`, `paused`, `typeCode`, `sort`, `direction`, `page`,
 * `pageSize`) the list mode answers one numbered page with the total and the five tab counts for
 * the same search and filters; the closed query refuses unknown keys, bad values and a page past
 * row 10,000. Rule: the key `catalog.own-product.view` and the seller population; the seller comes
 * from the actor and the reader takes it from there, so another seller's product is never read.
 * No price and no stock. Runs in one read-only unit (ADR-0025).
 */
export class OwnProductsList extends UseCase<
  OwnProductsListInput,
  OwnProductsListResult,
  OwnProductsListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-products-list',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnProductsListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnProductsListInput,
  ): Promise<Result<OwnProductsListResult, OwnProductsListFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    if (isListMode(input)) return this.list(context, sellerId, input);
    return this.keyset(context, sellerId, input);
  }

  /** The keyset list (`afterId`, `limit`): unchanged, for callers that do not send a list key. */
  private async keyset(
    context: CallContext,
    sellerId: Id<'Seller'>,
    input: OwnProductsListInput,
  ): Promise<Result<OwnProductsListOutput, OwnProductsListFailure>> {
    const page = parsePage<'Product'>(input);
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
        // One extra row tells whether another page follows.
        const rows = await this.deps.ownReader.listProducts(market, sellerId, {
          afterId: page.value.afterId,
          limit: page.value.limit + 1,
        });
        const shown = rows.slice(0, page.value.limit);
        const copies = await this.deps.ownReader.findWorkingCopies(
          market,
          shown.map((product) => product.state.id),
        );
        return ok({ rows, shown, copies });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const { rows, shown, copies } = read.value;
    const nameOf = new Map(
      copies.map((copy) => [copy.productId, draftNameOf(copy.content, locale)]),
    );
    const items = shown.map(({ state }): OwnProductListItem => ({
      productId: state.id,
      productCode: state.productCode,
      typeCode: state.typeCode,
      status: state.status,
      draftName: nameOf.get(state.id) ?? null,
      hasPublishedRevision: state.publishedRevisionId !== null,
      hasPendingRevision: state.pendingRevisionId !== null,
      pendingSubmittedAt: isoOf(state.pendingSubmittedAt),
      lastChangedAt: state.lastChangedAt.toString(),
      createdAt: state.createdAt.toString(),
    }));
    return ok({
      items,
      nextAfterId: rows.length > shown.length ? (shown[shown.length - 1]?.state.id ?? null) : null,
    });
  }

  /** The list with views, search, filters, sort, page numbers and counts. */
  private async list(
    context: CallContext,
    sellerId: Id<'Seller'>,
    input: OwnProductsListInput,
  ): Promise<Result<OwnProductsPageOutput, OwnProductsListFailure>> {
    const query = parseListQuery(input);
    if (!query.ok) return query;
    const q = query.value;
    const { market } = context;
    let locale: string;
    try {
      locale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const filterFor = (view: OwnProductView): OwnProductsFilter => filterOf(q, view, locale);
    const offset = (q.page - 1) * q.pageSize;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const reader = this.deps.ownReader;
        // Two reads for the five tabs: the products per status, and those in review.
        const totals = await reader.countProductViews(market, sellerId, filterFor('all'));
        const inStatuses = (view: OwnProductView): number =>
          VIEW_RULES[view].statuses.reduce(
            (sum, status) => sum + (totals.byStatus[status] ?? 0),
            0,
          );
        const counts: OwnProductViewCounts = {
          all: inStatuses('all'),
          drafts: inStatuses('drafts'),
          live: inStatuses('live'),
          inactive: inStatuses('inactive'),
          inReview: totals.inReview,
        };
        const total = counts[VIEW_COUNT_KEY[q.view]];
        const result =
          offset >= total
            ? ({ kind: 'rows', rows: [] } as const)
            : await reader.listProductPage(
                market,
                sellerId,
                filterFor(q.view),
                { sort: q.sort, direction: q.direction },
                { offset, limit: q.pageSize },
              );
        return ok({ counts, total, result });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const { counts, total, result } = read.value;
    if (result.kind === 'too-broad') return invalid('sort', 'too-broad');
    const items = result.rows.map((row): OwnProductPageItem => ({
      productId: row.productId,
      productCode: row.productCode,
      typeCode: row.typeCode,
      status: row.status,
      draftName: row.draftName,
      name: row.name,
      primaryImageId: row.primaryImageId,
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      offerCount: row.offerCount,
      pausedAt: isoOf(row.pausedAt),
      hasPublishedRevision: row.hasPublishedRevision,
      hasPendingRevision: row.hasPendingRevision,
      pendingSubmittedAt: isoOf(row.pendingSubmittedAt),
      lastChangedAt: row.lastChangedAt.toString(),
      createdAt: row.createdAt.toString(),
    }));
    return ok({ items, total, page: q.page, pageSize: q.pageSize, counts });
  }
}

/** The draft's name in a locale, read defensively: a draft is only shape-checked at save. */
export function draftNameOf(content: Record<string, unknown>, locale: string): string | null {
  const texts = content['texts'];
  if (typeof texts !== 'object' || texts === null) return null;
  const entry = (texts as Record<string, unknown>)[locale];
  if (typeof entry !== 'object' || entry === null) return null;
  const name = (entry as Record<string, unknown>)['name'];
  return typeof name === 'string' && name !== '' ? name : null;
}

const VIEW_COUNT_KEY: Readonly<Record<OwnProductView, keyof OwnProductViewCounts>> = {
  all: 'all',
  drafts: 'drafts',
  live: 'live',
  inactive: 'inactive',
  'in-review': 'inReview',
};

/** List mode when any list key is present; otherwise the keyset mode (so an empty query too). */
function isListMode(input: OwnProductsListInput): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    Object.keys(input).some((key) => LIST_KEY_SET.has(key))
  );
}

/** What picks products: a tab, a search and the filters. */
export interface OwnProductSelector {
  readonly view: OwnProductView;
  readonly text: string | null;
  readonly status: ProductStatus | null;
  readonly categoryId: Id<'Category'> | null;
  readonly paused: boolean | null;
  readonly typeCode: string | null;
}

export interface ParsedOwnListQuery extends OwnProductSelector {
  readonly sort: OwnProductSort;
  readonly direction: OwnSortDirection;
  readonly page: number;
  readonly pageSize: number;
}

const absent = (value: unknown): boolean => value === undefined || value === null || value === '';

function oneOf<T extends string>(
  path: string,
  value: unknown,
  allowed: readonly T[],
  fallback: T | null,
): Result<T | null, ValidationFailure> {
  if (absent(value)) return ok(fallback);
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? ok(value as T)
    : invalid(path, 'value');
}

/**
 * The closed query of the list: `afterId` and `limit` belong to the keyset mode and are refused
 * here, like an unknown key; bad values and out-of-range numbers are refused whole.
 */
export function parseListQuery(input: unknown): Result<ParsedOwnListQuery, ValidationFailure> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('query', 'type');
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    // The key is the caller's own text: echo no more than 64 characters of it.
    if (!LIST_KEY_SET.has(key)) return invalid(Array.from(key).slice(0, 64).join(''), 'unknown');
  }

  const view = oneOf('view', record['view'], OWN_PRODUCT_VIEWS, 'all');
  if (!view.ok) return view;
  const status = oneOf('status', record['status'], OWN_LISTED_STATUSES, null);
  if (!status.ok) return status;
  let categoryId: Id<'Category'> | null = null;
  if (!absent(record['categoryId'])) {
    const parsed =
      typeof record['categoryId'] === 'string' ? parseId<'Category'>(record['categoryId']) : null;
    if (parsed === null || !parsed.ok) return invalid('categoryId', 'format');
    categoryId = parsed.value;
  }
  let paused: boolean | null = null;
  if (!absent(record['paused'])) {
    if (typeof record['paused'] !== 'boolean') return invalid('paused', 'value');
    paused = record['paused'];
  }
  let text: string | null = null;
  if (!absent(record['q'])) {
    const value = record['q'];
    if (typeof value !== 'string' || Array.from(value).length > SEARCH_MAX_LENGTH) {
      return invalid('q', 'length');
    }
    // Control characters are never part of a name or a code.
    if (/\p{C}/u.test(value)) return invalid('q', 'format');
    text = value.trim() === '' ? null : value.trim();
  }
  let typeCode: string | null = null;
  if (!absent(record['typeCode'])) {
    const code = record['typeCode'];
    if (typeof code !== 'string' || !TYPE_CODE.test(code)) return invalid('typeCode', 'format');
    typeCode = code;
  }
  const sort = oneOf('sort', record['sort'], OWN_PRODUCT_SORTS, 'updated');
  if (!sort.ok) return sort;
  const direction = oneOf(
    'direction',
    record['direction'],
    ['asc', 'desc'] as const,
    sort.value === 'name' ? 'asc' : 'desc',
  );
  if (!direction.ok) return direction;
  let page = 1;
  if (!absent(record['page'])) {
    const value = record['page'];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      return invalid('page', 'range');
    }
    page = value;
  }
  let pageSize: number = DEFAULT_OWN_PAGE_SIZE;
  if (!absent(record['pageSize'])) {
    const value = record['pageSize'];
    if (typeof value !== 'number' || !(OWN_PAGE_SIZES as readonly number[]).includes(value)) {
      return invalid('pageSize', 'range');
    }
    pageSize = value;
  }
  // Page numbers stop at row 10,000: past it the seller narrows the list.
  if ((page - 1) * pageSize >= MAX_OWN_LIST_ROWS) return invalid('page', 'range');
  return ok({
    view: view.value as OwnProductView,
    text,
    status: status.value,
    categoryId,
    paused,
    typeCode,
    sort: sort.value as OwnProductSort,
    direction: direction.value as OwnSortDirection,
    page,
    pageSize,
  });
}

/** The filter of one tab for a selector: the tab's states, narrowed by a status filter. */
export function filterOf(
  selector: OwnProductSelector,
  view: OwnProductView,
  locale: string,
): OwnProductsFilter {
  const rule = VIEW_RULES[view];
  return {
    statuses: rule.statuses.filter(
      (status) => selector.status === null || status === selector.status,
    ),
    inReview: rule.inReview,
    paused: selector.paused,
    categoryId: selector.categoryId,
    typeCode: selector.typeCode,
    text: selector.text,
    locale,
  };
}
