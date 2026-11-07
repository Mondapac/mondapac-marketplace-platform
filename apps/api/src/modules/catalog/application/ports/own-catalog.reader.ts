import type { Id, MarketContext, MeasureSettings, Temporal } from '@mondapac/shared-kernel';
import type { Offer } from '../../domain/offer';
import type { Product, ProductStatus } from '../../domain/product';
import type { WorkingCopy } from '../../domain/working-copy';

/** One page request: the last id of the previous page, and at most `limit` rows. */
export interface ListPage<K extends string> {
  readonly afterId: Id<K> | null;
  readonly limit: number;
}

export interface ProductLabel {
  readonly productId: Id<'Product'>;
  readonly productCode: string;
  readonly typeCode: string;
  readonly name: string | null;
}

/** A SELLER product waiting for its pending revision to be reviewed (the review queue). */
export interface PendingRevisionRow {
  readonly productId: Id<'Product'>;
  /** The product version a decision must name. */
  readonly productVersion: number;
  readonly sellerId: Id<'Seller'>;
  readonly productCode: string;
  readonly typeCode: string;
  readonly revisionId: Id<'ProductRevision'>;
  readonly revisionNo: number;
  /** True while the product has never been published. */
  readonly firstPublication: boolean;
  readonly sensitiveReasons: readonly string[];
  readonly hasImages: boolean;
  /** The 14-digit GTINs of the pending revision's variants (V4), for the duplicate warning. */
  readonly variantGtins: readonly string[];
  readonly name: string | null;
  readonly submittedAt: Temporal.Instant;
}

/**
 * The review queue filters a product revision row can be read by (product version review B1). An
 * absent key does not filter. `hasImages` is the row's own: the pending revision lists a photo, in
 * any state (a taken-down photo counts, as on the row).
 */
export interface RevisionQueueFilter {
  readonly sellerId?: Id<'Seller'>;
  readonly firstPublication?: boolean;
  readonly hasImages?: boolean;
}

/** One field of a product family as the product form shows it: names and option labels per locale. */
export interface ProductFormField {
  readonly code: string;
  readonly dataType: string;
  readonly localizable: boolean;
  readonly required: boolean;
  readonly isVariantOption: boolean;
  readonly bounds: { readonly maxLength?: number; readonly min?: number; readonly max?: number };
  /** A measure field only: dimension, offered unit codes, default unit and decimal places. */
  readonly measure?: MeasureSettings;
  readonly names: Readonly<Record<string, string>>;
  readonly options: readonly {
    readonly code: string;
    readonly labels: Readonly<Record<string, string>>;
  }[];
}

/** An active platform category a product may be filed under. */
export interface ProductFormCategory {
  readonly categoryId: string;
  readonly parentId: string | null;
  readonly names: Readonly<Record<string, string>>;
}

export interface ProductForm {
  readonly fields: readonly ProductFormField[];
  readonly categories: readonly ProductFormCategory[];
}

/** The seller's Offers per status; `deleted` is never counted. */
export interface OfferStatusCounts {
  readonly draft: number;
  readonly pendingFirstPublish: number;
  readonly changesNeeded: number;
  readonly published: number;
}

/** The filters of the seller's product list; `statuses` is already narrowed by view and status. */
export interface OwnProductsFilter {
  /** A product matches when its status is any of these (none: no product matches). */
  readonly statuses: readonly ProductStatus[];
  /** True keeps only products with a pending revision (the In review view). */
  readonly inReview: boolean;
  /** True keeps paused products, false the ones not paused, null both. */
  readonly paused: boolean | null;
  readonly categoryId: Id<'Category'> | null;
  readonly typeCode: string | null;
  /** A case-insensitive part of the name (in `locale`) or of the product code; null for none. */
  readonly text: string | null;
  /** The Market's default locale: the language of the name and of the category name. */
  readonly locale: string;
}

export const OWN_PRODUCT_SORTS = ['name', 'updated', 'created'] as const;
export type OwnProductSort = (typeof OWN_PRODUCT_SORTS)[number];
export type OwnSortDirection = 'asc' | 'desc';

/** One row of the seller's product list. */
export interface OwnProductRow {
  readonly productId: Id<'Product'>;
  readonly productCode: string;
  readonly typeCode: string;
  readonly status: ProductStatus;
  /**
   * The name the seller sees: the draft's in `locale` while the product has a working copy, else
   * the shown revision's; null when it has none. The list filters on this same value.
   */
  readonly name: string | null;
  /** The draft's name in `locale` alone (kept for the keyset list's field of the same name). */
  readonly draftName: string | null;
  /** The first photo that is not taken down (the draft's, else the shown revision's). */
  readonly primaryImageId: Id<'ProductImage'> | null;
  readonly categoryId: Id<'Category'> | null;
  readonly categoryName: string | null;
  /** The seller's own Offers on the product that are not deleted. */
  readonly offerCount: number;
  readonly pausedAt: Temporal.Instant | null;
  readonly hasPublishedRevision: boolean;
  readonly hasPendingRevision: boolean;
  readonly pendingSubmittedAt: Temporal.Instant | null;
  readonly lastChangedAt: Temporal.Instant;
  readonly createdAt: Temporal.Instant;
}

/** Products kept by a filter: per status (a status with none is absent) and in review. */
export interface OwnProductViewTotals {
  readonly byStatus: Readonly<Record<string, number>>;
  readonly inReview: number;
}

export type OwnProductsPageResult =
  | { readonly kind: 'rows'; readonly rows: readonly OwnProductRow[] }
  /** Sorting by name needs the matching products in memory (at most 500); a search this wide must narrow. */
  | { readonly kind: 'too-broad' };

/**
 * The seller's own catalogue lists (catalog design 8.2, 9.2a): products and Offers of one seller,
 * newest first by id (UUID v7). The owner is in every statement, so another seller's row is never
 * read. Runs in the open (read-only) unit of the use case, through the Market-scoped client.
 */
export interface OwnCatalogReader {
  /** The seller's SELLER products except the discarded and withdrawn ones. */
  listProducts(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    page: ListPage<'Product'>,
  ): Promise<readonly Product[]>;

  /**
   * One page of the seller's SELLER products (never the discarded or withdrawn ones) that
   * `filter` keeps, `limit` rows after `offset` rows, in the given order (ties broken by id).
   */
  listProductPage(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    filter: OwnProductsFilter,
    order: { readonly sort: OwnProductSort; readonly direction: OwnSortDirection },
    page: { readonly offset: number; readonly limit: number },
  ): Promise<OwnProductsPageResult>;

  /**
   * How many of the seller's products `filter` keeps, per status, and how many of those have a
   * pending revision (two reads). `filter.inReview` is ignored: both answers are given.
   */
  countProductViews(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    filter: OwnProductsFilter,
  ): Promise<OwnProductViewTotals>;

  /** The seller's Offers that are not deleted. */
  listOffers(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    page: ListPage<'Offer'>,
  ): Promise<readonly Offer[]>;

  /** How many of the seller's Offers are in each status, deleted ones left out (one count). */
  offerStatusCounts(market: MarketContext, sellerId: Id<'Seller'>): Promise<OfferStatusCounts>;

  /**
   * How many Offers of the Market wait for their first publication (the review queue), of one
   * seller when `filter.sellerId` is given.
   */
  pendingReviewCount(
    market: MarketContext,
    filter?: { readonly sellerId?: Id<'Seller'> },
  ): Promise<number>;

  /** How many SELLER products hold a pending revision (the review queue) that `filter` keeps. */
  pendingRevisionCount(market: MarketContext, filter?: RevisionQueueFilter): Promise<number>;

  /**
   * SELLER products with a pending revision that `filter` keeps, oldest submit first (then by
   * product id), at most `limit` after `after` (the submit instant and product id of the last row
   * of the previous page; null for the first). The name is the pending revision's, in `locale`,
   * else null.
   */
  listPendingRevisions(
    market: MarketContext,
    page: {
      readonly after: { readonly submittedAt: Temporal.Instant; readonly id: string } | null;
      readonly limit: number;
    },
    locale: string,
    filter?: RevisionQueueFilter,
  ): Promise<readonly PendingRevisionRow[]>;

  /**
   * The code, type and published name (in `locale`, else null) of the given products of any
   * scope: the label an Offer row shows for its product. At most 100 ids; unknown ids are absent.
   */
  productLabels(
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
    locale: string,
  ): Promise<readonly ProductLabel[]>;

  /**
   * What the product form needs to be drawn: the fields of the family (published revisions, active
   * options only, in family order) and the active platform categories. Fields of a family that is
   * missing or archived: an empty list.
   */
  productForm(market: MarketContext, familyCode: string): Promise<ProductForm>;

  /** The working copies of the given products (at most 100 ids), in no order. */
  findWorkingCopies(
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
  ): Promise<readonly WorkingCopy[]>;
}

export const OWN_CATALOG_READER = Symbol('OWN_CATALOG_READER');
