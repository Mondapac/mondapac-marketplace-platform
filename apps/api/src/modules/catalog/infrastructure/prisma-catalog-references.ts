import { ok } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { MAX_CATALOG_REFERENCE_IDS, type CatalogReferences } from '../../certification';

/**
 * `certification`'s {@link CatalogReferences} port on catalog's own tables (certification design
 * 8.2, request C-3). Each call is one read-only unit of the given Market with one statement
 * (`marketId` at the top of `where`); an unknown id and an id of another Market are both absent.
 * More ids than the port allows, or a unit that answers an error, rejects.
 */
export class PrismaCatalogReferences implements CatalogReferences {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
  ) {}

  async platformCategoriesExist(
    market: MarketContext,
    categoryIds: readonly Id<'Category'>[],
  ): Promise<ReadonlySet<Id<'Category'>>> {
    const ids = [...new Set(categoryIds)];
    if (ids.length > MAX_CATALOG_REFERENCE_IDS) throw new RangeError('too many category ids');
    if (ids.length === 0) return new Set();
    const result = await this.unitOfWork.run(
      market,
      async () => {
        const rows = await this.prisma.tx(market).catalogPlatformCategory.findMany({
          where: { marketId: market.marketId, id: { in: ids }, status: 'active' },
          select: { id: true },
        });
        return ok(rows.map((row) => row.id as Id<'Category'>));
      },
      { readOnly: true },
    );
    if (!result.ok) throw new Error('catalog references read failed');
    return new Set(result.value);
  }
}
