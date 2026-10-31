import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { BrandState, BrandStatus } from '../../domain/brand';

/** A brand with its aliases and the number of this Market's products that point at it. */
export interface BrandDetailRecord {
  readonly brand: BrandState;
  readonly aliases: readonly string[];
  /** Products of the request's Market with this brand, whatever their status. */
  readonly productCount: number;
}

export interface BrandListQuery {
  readonly status: BrandStatus | null;
  /** Matches the name, the slug or an alias; case-insensitive. */
  readonly search: string | null;
  readonly afterId: Id<'Brand'> | null;
  readonly limit: number;
}

export interface BrandListPage {
  readonly items: readonly BrandState[];
  /** The `afterId` of the next page; null on the last page. */
  readonly nextAfterId: Id<'Brand'> | null;
}

export interface MergeQueueRecord {
  readonly groupKey: string;
  readonly brands: readonly {
    readonly brand: BrandState;
    readonly productCount: number;
  }[];
}

/** An active brand as the public pages show it, with its live product count in the Market. */
export interface PublicBrandRecord {
  readonly brand: BrandState;
  readonly liveProductCount: number;
}

/**
 * The reads of the brand package (catalog brand package), all in a read-only unit. The public
 * reads see active brands only. A product counts as live in a Market when it is published there
 * and has at least one listed (on-sale) Offer, the rule the storefront reads apply to Offers.
 */
export interface BrandReader {
  list(market: MarketContext, query: BrandListQuery): Promise<BrandListPage>;

  detail(market: MarketContext, id: Id<'Brand'>): Promise<BrandDetailRecord | null>;

  /** Open merge-queue groups, oldest first, at most `limit`. */
  mergeQueue(market: MarketContext, limit: number): Promise<readonly MergeQueueRecord[]>;

  /** The active brand with this slug, with its live product count; null for any other status. */
  publicBySlug(market: MarketContext, slug: string): Promise<PublicBrandRecord | null>;

  /**
   * The ids of the live products (the rule of {@link PublicBrandRecord}) of the active brand with
   * this slug in this Market, at most `limit`, by product id; empty for an unknown, draft or
   * archived slug.
   */
  liveProductIds(
    market: MarketContext,
    slug: string,
    limit: number,
  ): Promise<readonly Id<'Product'>[]>;

  /** Every active brand, at most `limit`, in no particular order. */
  publicActive(market: MarketContext, limit: number): Promise<readonly BrandState[]>;

  /** Whether the seller owns at least one product marked as their own brand. */
  sellerHasOwnBrandProduct(market: MarketContext, sellerId: Id<'Seller'>): Promise<boolean>;
}

export const BRAND_READER = Symbol('BRAND_READER');
