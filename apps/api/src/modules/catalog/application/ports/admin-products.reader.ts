import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { ProductScope, ProductStatus } from '../../domain/product';

/**
 * One state a listed product can be in: its status and, for a published one, whether the admin
 * pause (design 4.1a) is on (`null`: either).
 */
export interface StateMatch {
  readonly status: ProductStatus;
  readonly paused: boolean | null;
}

/** The status a row shows: a paused product is `paused` (design 9.2b), else its own status. */
export type AdminProductStatus = ProductStatus | 'paused';

/** The filters of the admin product list; `matches` is already narrowed by view and status. */
export interface AdminProductsFilter {
  /** A product matches when it is in any of these states. */
  readonly matches: readonly StateMatch[];
  readonly scope: ProductScope | null;
  readonly categoryId: Id<'Category'> | null;
  readonly typeCode: string | null;
  readonly sellerId: Id<'Seller'> | null;
  /** A case-insensitive part of the name (in `locale`) or of the product code; null for none. */
  readonly text: string | null;
  /** The Market's default locale: the language of the name and of the category name. */
  readonly locale: string;
}

export const ADMIN_PRODUCT_SORTS = ['name', 'updated', 'created'] as const;
export type AdminProductSort = (typeof ADMIN_PRODUCT_SORTS)[number];
export type SortDirection = 'asc' | 'desc';

export interface AdminProductRow {
  readonly productId: Id<'Product'>;
  readonly productCode: string;
  /** The published revision's name, else the pending one's; null when neither has the locale. */
  readonly name: string | null;
  /** The primary photo of the same revision (position 1, not taken down); null without one. */
  readonly primaryImageId: Id<'ProductImage'> | null;
  readonly scope: ProductScope;
  readonly ownerSellerId: Id<'Seller'> | null;
  readonly categoryId: Id<'Category'> | null;
  readonly categoryName: string | null;
  readonly typeCode: string;
  readonly status: AdminProductStatus;
  /** Offers of the product that are not deleted, of every seller. */
  readonly offerCount: number;
  readonly updatedAt: Temporal.Instant;
  readonly createdAt: Temporal.Instant;
}

export type AdminProductsPageResult =
  | { readonly kind: 'rows'; readonly rows: readonly AdminProductRow[] }
  /** Sorting by name needs the matching products in memory; a search this wide must narrow. */
  | { readonly kind: 'too-broad' };

/**
 * The marketplace product list of the admin panel (catalog design 8.2, 9.2 `admin-products.list`):
 * products of one Market, both scopes. Runs in the open (read-only) unit of the use case, through
 * the Market-scoped client. It reads catalog tables only: no price, no stock.
 */
export interface AdminProductsReader {
  /** One page, `limit` rows after `offset` rows, in the given order (ties broken by id). */
  list(
    market: MarketContext,
    filter: AdminProductsFilter,
    order: { readonly sort: AdminProductSort; readonly direction: SortDirection },
    page: { readonly offset: number; readonly limit: number },
  ): Promise<AdminProductsPageResult>;

  /** How many products each filter matches, in the order given. */
  counts(
    market: MarketContext,
    filters: readonly AdminProductsFilter[],
  ): Promise<readonly number[]>;

  /**
   * The ids of the products a filter matches, newest change first (then by id), at most `limit`
   * (a bulk action or an export resolving "all products in this filter").
   */
  ids(
    market: MarketContext,
    filter: AdminProductsFilter,
    limit: number,
  ): Promise<readonly Id<'Product'>[]>;

  /** Which of these ids are products of this Market (a repeated id is answered once). */
  existing(market: MarketContext, ids: readonly Id<'Product'>[]): Promise<ReadonlySet<string>>;

  /** The state of each of these products that exists, for a bulk action to classify. */
  states(market: MarketContext, ids: readonly Id<'Product'>[]): Promise<readonly ProductState[]>;

  /** The rows of these products, in the order of `ids`; an unknown id is left out. */
  rowsByIds(
    market: MarketContext,
    ids: readonly Id<'Product'>[],
    locale: string,
  ): Promise<readonly AdminProductRow[]>;
}

/** What a bulk action needs to know about one product before it runs. */
export interface ProductState {
  readonly productId: Id<'Product'>;
  readonly scope: ProductScope;
  readonly status: ProductStatus;
  readonly paused: boolean;
  /** Offers of the product that are not deleted. */
  readonly offerCount: number;
}

export const ADMIN_PRODUCTS_READER = Symbol('ADMIN_PRODUCTS_READER');
