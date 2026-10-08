import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type {
  CategoryTreeVersion,
  PlatformCategoryRepository,
} from '../application/ports/platform-category.repository';
import type { PlatformCategory } from '../domain/platform-category';

const toDate = (instant: { readonly epochMilliseconds: number }): Date =>
  new Date(instant.epochMilliseconds);

/**
 * {@link PlatformCategoryRepository} on `catalog.category_trees`, `platform_categories`,
 * `platform_category_revisions` and `platform_category_revision_names`. Every statement goes
 * through `PrismaService.tx(market)` with `marketId` at the top level of `where`; no row is ever
 * deleted and the revisions are insert-only.
 */
export class PrismaPlatformCategoryRepository implements PlatformCategoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async treeVersion(market: MarketContext): Promise<CategoryTreeVersion> {
    // The market guard refuses an upsert by id and the row's id is its Market, so the row is
    // ensured first: a no-op, taking no lock, when it exists.
    const tx = this.prisma.tx(market);
    await tx.catalogCategoryTree.createMany({
      data: [{ marketId: market.marketId, tenantId: market.tenantId, version: 1 }],
      skipDuplicates: true,
    });
    const row = await tx.catalogCategoryTree.findFirstOrThrow({
      where: { marketId: market.marketId },
      select: { version: true },
    });
    return { version: row.version };
  }

  async bumpTreeVersion(market: MarketContext, expected: number): Promise<void> {
    const { count } = await this.prisma.tx(market).catalogCategoryTree.updateMany({
      where: { marketId: market.marketId, version: expected },
      data: { version: expected + 1 },
    });
    if (count !== 1) throw new StaleAggregateError('category-tree', market.marketId);
  }

  async idBySlug(market: MarketContext, slug: string): Promise<Id<'Category'> | null> {
    const row = await this.prisma.tx(market).catalogPlatformCategory.findFirst({
      where: { marketId: market.marketId, slug },
      select: { id: true },
    });
    return row === null ? null : (row.id as Id<'Category'>);
  }

  async add(market: MarketContext, category: PlatformCategory): Promise<void> {
    const state = category.state;
    const tx = this.prisma.tx(market);
    await tx.catalogPlatformCategory.create({
      data: {
        id: state.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        parentId: state.parentId,
        verticalRootCode: state.verticalRootCode,
        slug: state.slug,
        status: state.status,
        mergedIntoId: null,
        publishedRevisionId: null,
        createdByKind: state.createdByKind,
        version: state.version,
        createdAt: toDate(state.createdAt),
      },
      select: { id: true },
    });
    await tx.catalogPlatformCategoryRevision.create({
      data: {
        id: state.revisionId,
        marketId: market.marketId,
        tenantId: market.tenantId,
        categoryId: state.id,
        revisionNo: state.revisionNo,
        parentId: state.parentId,
        changeKind: 'created',
        authorKind: state.createdByKind,
        authorAccountId: null,
        createdAt: toDate(state.createdAt),
      },
      select: { id: true },
    });
    await tx.catalogPlatformCategoryRevisionName.createMany({
      data: state.names.map((entry) => ({
        marketId: market.marketId,
        tenantId: market.tenantId,
        revisionId: state.revisionId,
        locale: entry.locale,
        name: entry.name,
      })),
    });
    const { count } = await tx.catalogPlatformCategory.updateMany({
      where: { marketId: market.marketId, id: state.id, version: state.version },
      data: { publishedRevisionId: state.revisionId },
    });
    if (count !== 1) throw new StaleAggregateError('platform-category', state.id);
  }
}
