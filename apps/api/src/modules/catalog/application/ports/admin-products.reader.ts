import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { ProductScope, ProductStatus } from '../../domain/product';

/** The filters of the admin product list; `statuses` is already narrowed by view and status. */
export interface AdminProductsFilter {
  readonly statuses: readonly ProductStatus[];
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
  readonly status: ProductStatus;
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
}

export const ADMIN_PRODUCTS_READER = Symbol('ADMIN_PRODUCTS_READER');
