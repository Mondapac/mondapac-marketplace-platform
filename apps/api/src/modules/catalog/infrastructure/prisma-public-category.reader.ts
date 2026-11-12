import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { PublicCategoryReader } from '../application/ports/public-category.reader';
import type { PublicCategoryDetails } from '../domain/public-category';

/**
 * {@link PublicCategoryReader} on `catalog.platform_categories`, the text rows of their published
 * revisions, the slug history, and the published products with their Offers (data design 3.4,
 * 3.9). Plain Prisma reads, each scoped by `market_id` first; no join outside catalog.
 */
export class PrismaPublicCategoryReader implements PublicCategoryReader {
  constructor(private readonly prisma: PrismaService) {}

  async details(
    market: MarketContext,
    limit: number,
  ): Promise<ReadonlyMap<Id<'Category'>, PublicCategoryDetails>> {
    const tx = this.prisma.tx(market);
    const rows = await tx.catalogPlatformCategory.findMany({
      where: { marketId: market.marketId, status: 'active' },
      select: {
        id: true,
        showInMenu: true,
        seoTitle: true,
        seoDescription: true,
        seoNoindex: true,
        publishedRevision: {
          select: {
            texts: {
              where: { marketId: market.marketId },
              select: { locale: true, shortDescription: true },
            },
          },
        },
      },
      orderBy: { id: 'asc' },
      take: limit,
    });
    const result = new Map<Id<'Category'>, PublicCategoryDetails>();
    for (const row of rows) {
      const shortDescriptions = new Map<string, string>();
      for (const text of row.publishedRevision?.texts ?? []) {
        if (text.shortDescription !== null && text.shortDescription !== '') {
          shortDescriptions.set(text.locale, text.shortDescription);
        }
      }
      result.set(row.id as Id<'Category'>, {
        showInMenu: row.showInMenu,
        seo: { title: row.seoTitle, description: row.seoDescription, noindex: row.seoNoindex },
        shortDescriptions,
      });
    }
    return result;
  }

  async liveProductCounts(
    market: MarketContext,
    limit: number,
  ): Promise<ReadonlyMap<Id<'Category'>, number>> {
    const tx = this.prisma.tx(market);
    // From the category side, one group per category (on the indexed category column): the
    // revision must be the published one of a published, not paused product that has a listed
    // Offer (listed is exactly "published, no off-sale cause": CHECK offers_listed_check). A
    // product has one published revision and a revision one row per category, so a group's row
    // count is its number of products.
    const groups = await tx.catalogProductRevisionCategory.groupBy({
      by: ['categoryId'],
      where: {
        marketId: market.marketId,
        revision: {
          is: {
            marketId: market.marketId,
            publishedOf: {
              some: {
                marketId: market.marketId,
                status: 'published',
                pausedAt: null,
                offers: { some: { marketId: market.marketId, listed: true } },
              },
            },
          },
        },
      },
      _count: { _all: true },
      orderBy: { categoryId: 'asc' },
      take: limit,
    });
    return new Map(groups.map((group) => [group.categoryId as Id<'Category'>, group._count._all]));
  }

  async slugHistory(market: MarketContext, slug: string): Promise<Id<'Category'> | null> {
    const tx = this.prisma.tx(market);
    const row = await tx.catalogPlatformCategorySlugHistory.findFirst({
      where: { marketId: market.marketId, slug },
      select: { categoryId: true },
      orderBy: { retiredAt: 'desc' },
    });
    return row === null ? null : (row.categoryId as Id<'Category'>);
  }
}
