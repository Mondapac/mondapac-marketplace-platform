import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  BrandDetailRecord,
  BrandListPage,
  BrandListQuery,
  BrandReader,
  MergeQueueRecord,
  PublicBrandRecord,
} from '../application/ports/brand.reader';
import type { BrandState } from '../domain/brand';
import { brandStateOf } from './prisma-brand.repository';

/**
 * {@link BrandReader} on `catalog.brands`, `brand_aliases`, `brand_merge_candidates` and the
 * products that point at a brand. Brand statements carry no `marketId` (the models are exempt from
 * the market scope); every products statement carries the unit's. No join across modules: the
 * product count is a `count` on products by `brand_id`, the offers filter is catalog's own table.
 */
export class PrismaBrandReader implements BrandReader {
  constructor(private readonly prisma: PrismaService) {}

  async list(market: MarketContext, query: BrandListQuery): Promise<BrandListPage> {
    const tx = this.prisma.tx(market);
    const filters: Prisma.CatalogBrandWhereInput[] = [];
    if (query.status !== null) filters.push({ status: query.status });
    if (query.search !== null) {
      filters.push({
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { slug: { contains: query.search.toLowerCase() } },
          { aliases: { some: { alias: { contains: query.search, mode: 'insensitive' } } } },
        ],
      });
    }
    if (query.afterId !== null) {
      // Keyset by (name, id): the page starts after the row the cursor names.
      const cursor = await tx.catalogBrand.findFirst({
        where: { id: query.afterId },
        select: { name: true },
      });
      if (cursor === null) return { items: [], nextAfterId: null };
      filters.push({
        OR: [{ name: { gt: cursor.name } }, { name: cursor.name, id: { gt: query.afterId } }],
      });
    }
    const rows = await tx.catalogBrand.findMany({
      where: filters.length === 0 ? {} : { AND: filters },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(brandStateOf),
      nextAfterId: rows.length > query.limit ? (page[page.length - 1]!.id as Id<'Brand'>) : null,
    };
  }

  async detail(market: MarketContext, id: Id<'Brand'>): Promise<BrandDetailRecord | null> {
    const tx = this.prisma.tx(market);
    const row = await tx.catalogBrand.findFirst({
      where: { id },
      include: { aliases: { orderBy: [{ alias: 'asc' }], select: { alias: true } } },
    });
    if (row === null) return null;
    const productCount = await tx.catalogProduct.count({
      where: { marketId: market.marketId, brandId: id },
    });
    return {
      brand: brandStateOf(row),
      aliases: row.aliases.map((alias) => alias.alias),
      productCount,
    };
  }

  async mergeQueue(market: MarketContext, limit: number): Promise<readonly MergeQueueRecord[]> {
    const tx = this.prisma.tx(market);
    // The oldest open groups first: the keys by their earliest detection, then by key.
    const groups = await tx.catalogBrandMergeCandidate.groupBy({
      by: ['groupKey'],
      where: { status: 'open' },
      _min: { detectedAt: true },
      orderBy: [{ _min: { detectedAt: 'asc' } }, { groupKey: 'asc' }],
      take: limit,
    });
    if (groups.length === 0) return [];
    const rows = await tx.catalogBrandMergeCandidate.findMany({
      where: { status: 'open', groupKey: { in: groups.map((group) => group.groupKey) } },
      include: { brand: true },
      orderBy: [{ brand: { name: 'asc' } }, { brandId: 'asc' }],
    });
    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(
        row.brandId,
        await tx.catalogProduct.count({
          where: { marketId: market.marketId, brandId: row.brandId },
        }),
      );
    }
    return groups.map((group) => ({
      groupKey: group.groupKey,
      brands: rows
        .filter((row) => row.groupKey === group.groupKey)
        .map((row) => ({
          brand: brandStateOf(row.brand),
          productCount: counts.get(row.brandId) ?? 0,
        })),
    }));
  }

  async publicBySlug(market: MarketContext, slug: string): Promise<PublicBrandRecord | null> {
    const tx = this.prisma.tx(market);
    const row = await tx.catalogBrand.findFirst({ where: { slug, status: 'active' } });
    if (row === null) return null;
    // Live in this Market: published, with a published revision and an Offer that is on sale. The
    // same facts the storefront reads decide an Offer's and a product's visibility.
    const liveProductCount = await tx.catalogProduct.count({
      where: {
        marketId: market.marketId,
        brandId: row.id,
        status: 'published',
        publishedRevisionId: { not: null },
        offers: { some: { marketId: market.marketId, status: 'published', listed: true } },
      },
    });
    return { brand: brandStateOf(row), liveProductCount };
  }

  async publicActive(market: MarketContext, limit: number): Promise<readonly BrandState[]> {
    const rows = await this.prisma.tx(market).catalogBrand.findMany({
      where: { status: 'active' },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(brandStateOf);
  }

  async sellerHasOwnBrandProduct(market: MarketContext, sellerId: Id<'Seller'>): Promise<boolean> {
    const row = await this.prisma.tx(market).catalogProduct.findFirst({
      where: {
        marketId: market.marketId,
        ownerSellerId: sellerId,
        scope: 'SELLER',
        ownBrand: true,
        status: { not: 'discarded' },
      },
      select: { id: true },
    });
    return row !== null;
  }
}
