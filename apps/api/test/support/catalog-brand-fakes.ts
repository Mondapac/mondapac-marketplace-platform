import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  BrandDetailRecord,
  BrandListPage,
  BrandListQuery,
  BrandReader,
  MergeQueueRecord,
  PublicBrandRecord,
} from '../../src/modules/catalog/application/ports/brand.reader';
import type { BrandRepository } from '../../src/modules/catalog/application/ports/brand.repository';
import {
  Brand,
  brandNameKey,
  sameBrandSpelling,
  type BrandState,
} from '../../src/modules/catalog/domain/brand';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';

/**
 * In-memory brand store for the HTTP tests of the brand routes: one table of brands shared by
 * every Market (as in the database), the aliases, the merge queue and the per-Market product
 * facts the reader needs. It keeps the rules the database enforces: a unique slug, a unique alias
 * whatever its case, the version check on save.
 */
export class MemoryBrands implements BrandRepository, BrandReader {
  readonly brands = new Map<string, BrandState>();
  readonly aliases = new Map<string, string>(); // lower(alias) -> brand id (original spelling kept below)
  readonly spellings = new Map<string, string>(); // lower(alias) -> alias
  readonly candidates: { groupKey: string; brandId: string; status: 'open' | 'resolved' }[] = [];
  /** `${marketId}:${brandId}` -> number of products. */
  readonly productCounts = new Map<string, number>();
  /** `${marketId}:${sellerId}` of sellers with an ownBrand product. */
  readonly ownBrandSellers = new Set<string>();
  readonly liveCounts = new Map<string, number>();

  seed(state: BrandState): void {
    this.brands.set(state.id, state);
  }

  seedAlias(brandId: string, alias: string): void {
    this.aliases.set(alias.toLowerCase(), brandId);
    this.spellings.set(alias.toLowerCase(), alias);
  }

  reset(): void {
    this.brands.clear();
    this.aliases.clear();
    this.spellings.clear();
    this.candidates.length = 0;
    this.productCounts.clear();
    this.ownBrandSellers.clear();
    this.liveCounts.clear();
  }

  // --- BrandRepository

  add(_market: MarketContext, brand: Brand): Promise<'brand.slug-taken' | null> {
    if ([...this.brands.values()].some((row) => row.slug === brand.state.slug)) {
      return Promise.resolve('brand.slug-taken');
    }
    this.brands.set(brand.state.id, brand.state);
    return Promise.resolve(null);
  }

  findById(_market: MarketContext, id: Id<'Brand'>): Promise<Brand | null> {
    const state = this.brands.get(id);
    return Promise.resolve(state === undefined ? null : Brand.restore(state));
  }

  findBySlug(_market: MarketContext, slug: string): Promise<Brand | null> {
    const state = [...this.brands.values()].find((row) => row.slug === slug);
    return Promise.resolve(state === undefined ? null : Brand.restore(state));
  }

  save(_market: MarketContext, brand: Brand): Promise<'brand.slug-taken' | null> {
    const stored = this.brands.get(brand.state.id);
    if (stored === undefined || stored.version !== brand.persistedVersion) {
      return Promise.reject(new StaleAggregateError('brand', brand.state.id));
    }
    if (
      [...this.brands.values()].some(
        (row) => row.id !== brand.state.id && row.slug === brand.state.slug,
      )
    ) {
      return Promise.resolve('brand.slug-taken');
    }
    this.brands.set(brand.state.id, brand.state);
    return Promise.resolve(null);
  }

  slugTaken(_market: MarketContext, slug: string): Promise<boolean> {
    return Promise.resolve([...this.brands.values()].some((row) => row.slug === slug));
  }

  similarTo(
    _market: MarketContext,
    input: { readonly name: string; readonly nameKey: string; readonly limit: number },
  ): Promise<readonly BrandState[]> {
    return Promise.resolve(
      [...this.brands.values()]
        .filter(
          (row) =>
            row.status !== 'archived' &&
            (row.nameKey === input.nameKey ||
              this.aliases.get(input.name.toLowerCase()) === row.id),
        )
        .slice(0, input.limit),
    );
  }

  spellingOwners(
    _market: MarketContext,
    spelling: string,
    limit: number,
  ): Promise<readonly BrandState[]> {
    return Promise.resolve(
      [...this.brands.values()]
        .filter(
          (row) =>
            row.status !== 'archived' &&
            (sameBrandSpelling(row.name, spelling) ||
              this.aliases.get(spelling.toLowerCase()) === row.id),
        )
        .slice(0, limit),
    );
  }

  aliasesOf(_market: MarketContext, brandId: Id<'Brand'>): Promise<readonly string[]> {
    return Promise.resolve(this.#aliasesOf(brandId));
  }

  openProposalCount(_market: MarketContext, sellerId: Id<'Seller'>): Promise<number> {
    return Promise.resolve(
      [...this.brands.values()].filter(
        (row) => row.proposedBySellerId === sellerId && row.status === 'draft',
      ).length,
    );
  }

  addAliases(
    _market: MarketContext,
    brandId: Id<'Brand'>,
    aliases: readonly string[],
  ): Promise<readonly string[]> {
    const added: string[] = [];
    for (const alias of aliases) {
      if (this.aliases.has(alias.toLowerCase())) continue;
      this.seedAlias(brandId, alias);
      added.push(alias);
    }
    return Promise.resolve(added);
  }

  moveAliases(_market: MarketContext, from: Id<'Brand'>, to: Id<'Brand'>): Promise<void> {
    for (const [key, owner] of this.aliases) if (owner === from) this.aliases.set(key, to);
    return Promise.resolve();
  }

  moveProducts(market: MarketContext, from: Id<'Brand'>, to: Id<'Brand'>): Promise<number> {
    const moved = this.productCounts.get(`${market.marketId}:${from}`) ?? 0;
    this.productCounts.delete(`${market.marketId}:${from}`);
    this.productCounts.set(
      `${market.marketId}:${to}`,
      (this.productCounts.get(`${market.marketId}:${to}`) ?? 0) + moved,
    );
    return Promise.resolve(moved);
  }

  resolveMerged(
    _market: MarketContext,
    input: { readonly sources: readonly Id<'Brand'>[]; readonly target: Id<'Brand'> },
  ): Promise<void> {
    for (const row of this.candidates) {
      if (row.status === 'open' && input.sources.includes(row.brandId as Id<'Brand'>)) {
        row.status = 'resolved';
      }
    }
    return Promise.resolve();
  }

  dismissGroup(_market: MarketContext, input: { readonly groupKey: string }): Promise<number> {
    let count = 0;
    for (const row of this.candidates) {
      if (row.groupKey === input.groupKey && row.status === 'open') {
        row.status = 'resolved';
        count += 1;
      }
    }
    return Promise.resolve(count);
  }

  // --- BrandReader

  list(_market: MarketContext, query: BrandListQuery): Promise<BrandListPage> {
    const search = query.search?.toLowerCase() ?? null;
    const sorted = [...this.brands.values()]
      .filter((row) => query.status === null || row.status === query.status)
      .filter(
        (row) =>
          search === null ||
          row.name.toLowerCase().includes(search) ||
          row.slug.includes(search) ||
          this.#aliasesOf(row.id).some((alias) => alias.toLowerCase().includes(search)),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const start =
      query.afterId === null ? 0 : sorted.findIndex((row) => row.id === query.afterId) + 1;
    const items = sorted.slice(start, start + query.limit);
    const more = sorted.length > start + query.limit;
    return Promise.resolve({ items, nextAfterId: more ? items[items.length - 1]!.id : null });
  }

  detail(market: MarketContext, id: Id<'Brand'>): Promise<BrandDetailRecord | null> {
    const brand = this.brands.get(id);
    if (brand === undefined) return Promise.resolve(null);
    return Promise.resolve({
      brand,
      aliases: this.#aliasesOf(id),
      productCount: this.productCounts.get(`${market.marketId}:${id}`) ?? 0,
    });
  }

  mergeQueue(market: MarketContext, limit: number): Promise<readonly MergeQueueRecord[]> {
    const keys = [
      ...new Set(this.candidates.filter((row) => row.status === 'open').map((row) => row.groupKey)),
    ].slice(0, limit);
    return Promise.resolve(
      keys.map((groupKey) => ({
        groupKey,
        brands: this.candidates
          .filter((row) => row.status === 'open' && row.groupKey === groupKey)
          .map((row) => ({
            brand: this.brands.get(row.brandId)!,
            productCount: this.productCounts.get(`${market.marketId}:${row.brandId}`) ?? 0,
          })),
      })),
    );
  }

  publicBySlug(market: MarketContext, slug: string): Promise<PublicBrandRecord | null> {
    const brand = [...this.brands.values()].find((row) => row.slug === slug);
    if (brand === undefined || brand.status !== 'active') return Promise.resolve(null);
    return Promise.resolve({
      brand,
      liveProductCount: this.liveCounts.get(`${market.marketId}:${brand.id}`) ?? 0,
    });
  }

  publicActive(_market: MarketContext, limit: number): Promise<readonly BrandState[]> {
    return Promise.resolve(
      [...this.brands.values()]
        .filter((row) => row.status === 'active')
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, limit),
    );
  }

  sellerHasOwnBrandProduct(market: MarketContext, sellerId: Id<'Seller'>): Promise<boolean> {
    return Promise.resolve(this.ownBrandSellers.has(`${market.marketId}:${sellerId}`));
  }

  #aliasesOf(brandId: string): string[] {
    return [...this.aliases.entries()]
      .filter(([, owner]) => owner === brandId)
      .map(([key]) => this.spellings.get(key)!)
      .sort();
  }
}

/** A brand row for a test: defaults to an active brand of the given name. */
export function brandState(
  id: Id<'Brand'>,
  name: string,
  overrides: Partial<BrandState> = {},
): BrandState {
  const at = Temporal.Instant.from('2026-10-28T00:00:00Z');
  return {
    id,
    slug: name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, ''),
    name,
    nameKey: brandNameKey(name),
    logoImageId: null,
    logoAlt: null,
    headerImageId: null,
    summary: null,
    originCountry: null,
    status: 'active',
    proposedBySellerId: null,
    approvedBy: null,
    mergedIntoId: null,
    createdAt: at,
    updatedAt: at,
    version: 1,
    ...overrides,
  };
}
