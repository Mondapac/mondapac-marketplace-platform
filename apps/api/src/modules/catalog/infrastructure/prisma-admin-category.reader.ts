import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  AdminCategoryReader,
  AdminCategoryRevisionRecord,
  CategoryProductFacts,
} from '../application/ports/admin-category.reader';
import type { AdminStoredCategory, CategoryProductFact } from '../domain/category-admin-tree';
import type { CategoryStatus } from '../domain/platform-category';

/** The products read per statement; between two statements the time bound is checked. */
const PRODUCT_PAGE = 500;

/**
 * {@link AdminCategoryReader} on `catalog.platform_categories`, their revisions and names, and the
 * published products with their Offers (data design 3.4, 3.9). Plain Prisma reads, each scoped by
 * `market_id`; the counts are folded in memory by the domain (`adminCategoryTree`), so no raw SQL.
 */
export class PrismaAdminCategoryReader implements AdminCategoryReader {
  constructor(
    private readonly prisma: PrismaService,
    /** A monotonic clock in milliseconds; a test passes its own. */
    private readonly now: () => number = () => performance.now(),
    /** The products read per statement; a test passes a small one. */
    private readonly pageSize: number = PRODUCT_PAGE,
  ) {}

  async categories(market: MarketContext, limit: number): Promise<readonly AdminStoredCategory[]> {
    const tx = this.prisma.tx(market);
    const rows = await tx.catalogPlatformCategory.findMany({
      where: { marketId: market.marketId },
      select: {
        id: true,
        parentId: true,
        slug: true,
        status: true,
        mergedIntoId: true,
        version: true,
        publishedRevision: {
          select: { revisionNo: true, names: { select: { locale: true, name: true } } },
        },
      },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id as Id<'Category'>,
      parentId: row.parentId as Id<'Category'> | null,
      slug: row.slug,
      status: row.status as CategoryStatus,
      mergedIntoId: row.mergedIntoId as Id<'Category'> | null,
      names: row.publishedRevision?.names ?? [],
      revisionNo: row.publishedRevision?.revisionNo ?? 0,
      version: row.version,
    }));
  }

  async treeVersion(market: MarketContext): Promise<number> {
    const tx = this.prisma.tx(market);
    const row = await tx.catalogCategoryTree.findFirst({
      where: { marketId: market.marketId },
      select: { version: true },
    });
    return row?.version ?? 0;
  }

  async productFacts(market: MarketContext, budgetMs: number): Promise<CategoryProductFacts> {
    const tx = this.prisma.tx(market);
    const started = this.now();
    const facts: CategoryProductFact[] = [];
    let afterId: string | null = null;
    for (;;) {
      const page: {
        id: string;
        publishedRevision: { categories: { categoryId: string }[] } | null;
        offers: { listed: boolean; tags: { id: string }[] }[];
      }[] = await tx.catalogProduct.findMany({
        where: {
          marketId: market.marketId,
          status: 'published',
          publishedRevisionId: { not: null },
          ...(afterId === null ? {} : { id: { gt: afterId } }),
        },
        select: {
          id: true,
          publishedRevision: { select: { categories: { select: { categoryId: true } } } },
          offers: {
            where: { marketId: market.marketId, status: { not: 'deleted' } },
            select: {
              listed: true,
              tags: { where: { status: 'active' }, select: { id: true }, take: 1 },
            },
          },
        },
        orderBy: { id: 'asc' },
        take: this.pageSize,
      });
      for (const product of page) {
        facts.push({
          categoryIds: (product.publishedRevision?.categories ?? []).map((c) => c.categoryId),
          offers: product.offers.length,
          listedOffers: product.offers.filter((offer) => offer.listed).length,
          offersWithActiveTag: product.offers.filter((offer) => offer.tags.length > 0).length,
        });
      }
      if (page.length < this.pageSize) return { facts, complete: true };
      afterId = page[page.length - 1]!.id;
      if (this.now() - started >= budgetMs) return { facts, complete: false };
    }
  }

  async revisions(
    market: MarketContext,
    id: Id<'Category'>,
    limit: number,
  ): Promise<readonly AdminCategoryRevisionRecord[]> {
    const tx = this.prisma.tx(market);
    const rows = await tx.catalogPlatformCategoryRevision.findMany({
      where: { marketId: market.marketId, categoryId: id },
      select: {
        revisionNo: true,
        changeKind: true,
        authorKind: true,
        authorAccountId: true,
        parentId: true,
        createdAt: true,
        names: { select: { locale: true, name: true } },
      },
      orderBy: { revisionNo: 'desc' },
      take: limit,
    });
    return rows.map((row) => ({
      revisionNo: row.revisionNo,
      changeKind: row.changeKind,
      authorKind: row.authorKind as 'seed' | 'admin',
      authorAccountId: row.authorAccountId as Id<'Account'> | null,
      parentId: row.parentId as Id<'Category'> | null,
      names: [...row.names].sort((a, b) => (a.locale < b.locale ? -1 : 1)),
      createdAt: Temporal.Instant.fromEpochMilliseconds(row.createdAt.getTime()),
    }));
  }
}
