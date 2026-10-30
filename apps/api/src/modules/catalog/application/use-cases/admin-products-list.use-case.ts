import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import { PRODUCT_SCOPES, type ProductScope, type ProductStatus } from '../../domain/product';
import {
  ADMIN_PRODUCT_SORTS,
  type AdminProductSort,
  type AdminProductsFilter,
  type AdminProductsReader,
  type SortDirection,
} from '../ports/admin-products.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { SellerNamesReader } from '../ports/seller-names.reader';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';

export { ADMIN_PRODUCT_SORTS };

/** The tabs of the list: what each shows, by product status (catalog design 9.2). */
export const ADMIN_PRODUCT_VIEWS = ['active', 'all', 'inactive'] as const;
export type AdminProductView = (typeof ADMIN_PRODUCT_VIEWS)[number];

/** `active` is published; `inactive` is unpublished and withdrawn; `all` is every listed status. */
export const VIEW_STATUSES: Readonly<Record<AdminProductView, readonly ProductStatus[]>> =
  Object.freeze({
    active: ['published'],
    inactive: ['unpublished', 'withdrawn'],
    all: ['unpublished', 'published', 'matched', 'withdrawn', 'retired'],
  });

/** The statuses a row of the list can have, for the status filter. */
export const LISTED_STATUSES = VIEW_STATUSES.all;

export const DEFAULT_ADMIN_PAGE_SIZE = 25;
export const MAX_ADMIN_PAGE_SIZE = 100;
export const MAX_ADMIN_PAGE = 1000;
export const SEARCH_MAX_LENGTH = 100;

export interface AdminProductsListInput {
  readonly view?: unknown;
  readonly q?: unknown;
  readonly scope?: unknown;
  readonly status?: unknown;
  readonly categoryId?: unknown;
  readonly typeCode?: unknown;
  readonly sellerId?: unknown;
  readonly sort?: unknown;
  readonly direction?: unknown;
  readonly page?: unknown;
  readonly pageSize?: unknown;
}

export interface AdminProductListItem {
  readonly productId: string;
  readonly productCode: string;
  /** The name in the Market's default locale; null when the product has none in it. */
  readonly name: string | null;
  readonly primaryImageId: string | null;
  readonly scope: ProductScope;
  readonly ownerSellerId: string | null;
  /** The owner's public store name; null for PLATFORM, or when `sellers` cannot say. */
  readonly ownerStoreName: string | null;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly typeCode: string;
  readonly status: ProductStatus;
  readonly offerCount: number;
  readonly updatedAt: string;
  readonly createdAt: string;
}

export interface AdminProductViewCounts {
  readonly active: number;
  readonly all: number;
  readonly inactive: number;
}

export interface AdminProductsListOutput {
  readonly items: readonly AdminProductListItem[];
  /** Products matching the view and the filters, over all pages. */
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  /** Per tab, for the same search and filters (the status filter included). */
  readonly counts: AdminProductViewCounts;
}

export type AdminProductsListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface AdminProductsListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly adminProductsReader: AdminProductsReader;
  readonly policy: CatalogMarketPolicy;
  readonly sellerNames: SellerNamesReader;
}

const KEYS = new Set<string>([
  'view',
  'q',
  'scope',
  'status',
  'categoryId',
  'typeCode',
  'sellerId',
  'sort',
  'direction',
  'page',
  'pageSize',
]);
const TYPE_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

interface Parsed {
  readonly view: AdminProductView;
  readonly text: string | null;
  readonly scope: ProductScope | null;
  readonly status: ProductStatus | null;
  readonly categoryId: Id<'Category'> | null;
  readonly typeCode: string | null;
  readonly sellerId: Id<'Seller'> | null;
  readonly sort: AdminProductSort;
  readonly direction: SortDirection;
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

function idOf<K extends string>(
  path: string,
  value: unknown,
): Result<Id<K> | null, ValidationFailure> {
  if (absent(value)) return ok(null);
  const parsed = typeof value === 'string' ? parseId<K>(value) : null;
  return parsed === null || !parsed.ok ? invalid(path, 'format') : ok(parsed.value);
}

function wholeOf(
  path: string,
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): Result<number, ValidationFailure> {
  if (absent(value)) return ok(fallback);
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? ok(value)
    : invalid(path, 'range');
}

/** The closed query of the list: unknown keys, bad values and out-of-range numbers are refused. */
function parse(input: unknown): Result<Parsed, ValidationFailure> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('query', 'type');
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!KEYS.has(key)) return invalid(key, 'unknown');

  const view = oneOf('view', record['view'], ADMIN_PRODUCT_VIEWS, 'active');
  if (!view.ok) return view;
  const scope = oneOf('scope', record['scope'], PRODUCT_SCOPES, null);
  if (!scope.ok) return scope;
  const status = oneOf('status', record['status'], LISTED_STATUSES, null);
  if (!status.ok) return status;
  const categoryId = idOf<'Category'>('categoryId', record['categoryId']);
  if (!categoryId.ok) return categoryId;
  const sellerId = idOf<'Seller'>('sellerId', record['sellerId']);
  if (!sellerId.ok) return sellerId;
  const sort = oneOf('sort', record['sort'], ADMIN_PRODUCT_SORTS, 'updated');
  if (!sort.ok) return sort;
  const direction = oneOf(
    'direction',
    record['direction'],
    ['asc', 'desc'] as const,
    sort.value === 'name' ? 'asc' : 'desc',
  );
  if (!direction.ok) return direction;
  const page = wholeOf('page', record['page'], 1, 1, MAX_ADMIN_PAGE);
  if (!page.ok) return page;
  const pageSize = wholeOf(
    'pageSize',
    record['pageSize'],
    DEFAULT_ADMIN_PAGE_SIZE,
    1,
    MAX_ADMIN_PAGE_SIZE,
  );
  if (!pageSize.ok) return pageSize;

  let text: string | null = null;
  if (!absent(record['q'])) {
    const q = record['q'];
    if (typeof q !== 'string' || Array.from(q).length > SEARCH_MAX_LENGTH) {
      return invalid('q', 'length');
    }
    // Control characters are never part of a name or a code.
    if (/\p{C}/u.test(q)) return invalid('q', 'format');
    text = q.trim() === '' ? null : q.trim();
  }
  let typeCode: string | null = null;
  if (!absent(record['typeCode'])) {
    const code = record['typeCode'];
    if (typeof code !== 'string' || !TYPE_CODE.test(code)) return invalid('typeCode', 'format');
    typeCode = code;
  }
  return ok({
    view: view.value as AdminProductView,
    text,
    scope: scope.value,
    status: status.value,
    categoryId: categoryId.value,
    typeCode,
    sellerId: sellerId.value,
    sort: sort.value as AdminProductSort,
    direction: direction.value as SortDirection,
    page: page.value,
    pageSize: pageSize.value,
  });
}

/**
 * `admin-products.list` (catalog design 8.2, 9.2): the products of the caller's Market, PLATFORM
 * and SELLER scope, for the admin Catalogue page. A tab (`view`) narrows by status (`active` is
 * published, `inactive` is unpublished and withdrawn, `all` every status but draft and
 * discarded); free text matches the name in the Market's default locale or the product code;
 * filters narrow by scope, status, category, product type and owner seller; paged by `page` and
 * `pageSize`. The answer carries the three tab counts for the same search and filters. Rule: the
 * key `catalog.product.view` and the admin population; the Market comes from the context, so
 * another Market's product is never read. No price and no stock: catalog does not import
 * `pricing` or `inventory`. One read-only unit (ADR-0025); the store-name call follows it.
 */
export class AdminProductsList extends UseCase<
  AdminProductsListInput,
  AdminProductsListOutput,
  AdminProductsListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-products-list',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminProductsListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AdminProductsListInput,
  ): Promise<Result<AdminProductsListOutput, AdminProductsListFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const query = parse(input);
    if (!query.ok) return query;
    const q = query.value;
    let locale: string;
    try {
      locale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    // A tab shows its statuses; a status filter narrows them further (maybe to none).
    const filterFor = (view: AdminProductView): AdminProductsFilter => ({
      statuses: VIEW_STATUSES[view].filter((status) => q.status === null || status === q.status),
      scope: q.scope,
      categoryId: q.categoryId,
      typeCode: q.typeCode,
      sellerId: q.sellerId,
      text: q.text,
      locale,
    });
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const reader = this.deps.adminProductsReader;
        const [active = 0, all = 0, inactive = 0] = await reader.counts(
          market,
          ADMIN_PRODUCT_VIEWS.map(filterFor),
        );
        const counts: AdminProductViewCounts = { active, all, inactive };
        const total = counts[q.view];
        const offset = (q.page - 1) * q.pageSize;
        const result =
          offset >= total
            ? ({ kind: 'rows', rows: [] } as const)
            : await reader.list(
                market,
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

    const owners = [
      ...new Set(
        result.rows.flatMap((row) => (row.ownerSellerId === null ? [] : [row.ownerSellerId])),
      ),
    ];
    const names = await this.deps.sellerNames.storeNames(context, owners);
    const items = result.rows.map((row): AdminProductListItem => ({
      productId: row.productId,
      productCode: row.productCode,
      name: row.name,
      primaryImageId: row.primaryImageId,
      scope: row.scope,
      ownerSellerId: row.ownerSellerId,
      ownerStoreName: row.ownerSellerId === null ? null : (names.get(row.ownerSellerId) ?? null),
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      typeCode: row.typeCode,
      status: row.status,
      offerCount: row.offerCount,
      updatedAt: row.updatedAt.toString(),
      createdAt: row.createdAt.toString(),
    }));
    return ok({ items, total, page: q.page, pageSize: q.pageSize, counts });
  }
}
