import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { Brand, BrandState } from '../../domain/brand';

/**
 * The store of brands, their aliases and the merge queue (catalog brand package). Every method
 * runs in the open unit of the use case. Brands are shared by every Market, but the guarded client
 * still opens its unit for one Market, so each method takes the unit's `market`; no brand row is
 * ever read or written by Market.
 */
export interface BrandRepository {
  /** Inserts a brand built by `Brand.create`. `brand.slug-taken` when the slug exists. */
  add(market: MarketContext, brand: Brand): Promise<'brand.slug-taken' | null>;

  findById(market: MarketContext, id: Id<'Brand'>): Promise<Brand | null>;

  findBySlug(market: MarketContext, slug: string): Promise<Brand | null>;

  /**
   * Writes a changed brand under the version it was read at. Throws `StaleAggregateError` when
   * the row changed since. `brand.slug-taken` when a draft's new slug exists.
   */
  save(market: MarketContext, brand: Brand): Promise<'brand.slug-taken' | null>;

  /** Whether a brand already uses this slug, whatever its status. */
  slugTaken(market: MarketContext, slug: string): Promise<boolean>;

  /**
   * Brands that are not archived and look like a new name: the same name key, or an alias that
   * is the name apart from case. At most `limit`, oldest first. The near-duplicate check.
   */
  similarTo(
    market: MarketContext,
    input: { readonly name: string; readonly nameKey: string; readonly limit: number },
  ): Promise<readonly BrandState[]>;

  /**
   * Brands that are not archived and answer to this spelling, as their name or as an alias,
   * apart from case. At most `limit`, oldest first.
   */
  spellingOwners(
    market: MarketContext,
    spelling: string,
    limit: number,
  ): Promise<readonly BrandState[]>;

  aliasesOf(market: MarketContext, brandId: Id<'Brand'>): Promise<readonly string[]>;

  /** The proposals of one seller that wait for a decision. */
  openProposalCount(market: MarketContext, sellerId: Id<'Seller'>): Promise<number>;

  /**
   * Records `aliases` for `brandId`; a spelling that already exists (case-insensitive) is left
   * alone. Returns the spellings that were new.
   */
  addAliases(
    market: MarketContext,
    brandId: Id<'Brand'>,
    aliases: readonly string[],
    now: Temporal.Instant,
  ): Promise<readonly string[]>;

  /** Re-points the aliases of `from` to `to`. */
  moveAliases(market: MarketContext, from: Id<'Brand'>, to: Id<'Brand'>): Promise<void>;

  /** Re-points the products of this Market from one brand to another; the number moved. */
  moveProducts(market: MarketContext, from: Id<'Brand'>, to: Id<'Brand'>): Promise<number>;

  /**
   * After a merge: the queue rows of the merged `sources` are resolved as `merged`, and so is the
   * target's own row when no other open row shares its group.
   */
  resolveMerged(
    market: MarketContext,
    input: {
      readonly sources: readonly Id<'Brand'>[];
      readonly target: Id<'Brand'>;
      readonly accountId: Id<'Account'>;
      readonly now: Temporal.Instant;
    },
  ): Promise<void>;

  /** Resolves every open row of a group as `kept-separate`; the number resolved. */
  dismissGroup(
    market: MarketContext,
    input: {
      readonly groupKey: string;
      readonly accountId: Id<'Account'>;
      readonly now: Temporal.Instant;
    },
  ): Promise<number>;
}

export const BRAND_REPOSITORY = Symbol('BRAND_REPOSITORY');
