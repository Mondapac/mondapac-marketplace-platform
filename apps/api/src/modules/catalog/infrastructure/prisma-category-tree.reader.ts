import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { CategoryTreeReader } from '../application/ports/category-tree.reader';
import type { CategoryStatus } from '../domain/platform-category';
import type { StoredCategoryNode } from '../domain/category-tree';

/**
 * {@link CategoryTreeReader} on `catalog.platform_categories` and the name rows of the published
 * revisions (data design 3.4). Two statements, no join, both scoped by `market_id` first.
 */
export class PrismaCategoryTreeReader implements CategoryTreeReader {
  constructor(private readonly prisma: PrismaService) {}

  async nodes(market: MarketContext, limit: number): Promise<readonly StoredCategoryNode[]> {
    const tx = this.prisma.tx(market);
    const rows = await tx.catalogPlatformCategory.findMany({
      where: { marketId: market.marketId },
      select: {
        id: true,
        parentId: true,
        status: true,
        mergedIntoId: true,
        slug: true,
        publishedRevisionId: true,
      },
      orderBy: { id: 'asc' },
      take: limit,
    });
    const revisionIds = rows
      .filter((row) => row.status === 'active' && row.publishedRevisionId !== null)
      .map((row) => row.publishedRevisionId as string);
    const names =
      revisionIds.length === 0
        ? []
        : await tx.catalogPlatformCategoryRevisionName.findMany({
            where: { marketId: market.marketId, revisionId: { in: revisionIds } },
            select: { revisionId: true, locale: true, name: true },
          });
    const namesOf = new Map<string, { locale: string; name: string }[]>();
    for (const row of names) {
      const list = namesOf.get(row.revisionId) ?? [];
      list.push({ locale: row.locale, name: row.name });
      namesOf.set(row.revisionId, list);
    }
    return rows.map((row) => ({
      id: row.id as Id<'Category'>,
      parentId: row.parentId as Id<'Category'> | null,
      status: row.status as CategoryStatus,
      mergedIntoId: row.mergedIntoId as Id<'Category'> | null,
      slug: row.slug,
      names:
        row.status === 'active' && row.publishedRevisionId !== null
          ? (namesOf.get(row.publishedRevisionId) ?? [])
          : [],
    }));
  }
}
