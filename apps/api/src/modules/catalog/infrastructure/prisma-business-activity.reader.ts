import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  BusinessActivityListPage,
  BusinessActivityListQuery,
  BusinessActivityReader,
} from '../application/ports/business-activity.reader';
import { ACTIVITY_INCLUDE, activityStateOf } from './prisma-business-activity.repository';

/** {@link BusinessActivityReader} on the business-activity tables; every statement carries the Market. */
export class PrismaBusinessActivityReader implements BusinessActivityReader {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    market: MarketContext,
    query: BusinessActivityListQuery,
  ): Promise<BusinessActivityListPage> {
    const tx = this.prisma.tx(market);
    const filters: Prisma.CatalogBusinessActivityWhereInput[] = [];
    if (query.status !== null) filters.push({ status: query.status });
    if (query.search !== null) {
      filters.push({
        OR: [
          { code: { contains: query.search.toLowerCase() } },
          { names: { some: { name: { contains: query.search, mode: 'insensitive' } } } },
        ],
      });
    }
    if (query.afterId !== null) {
      // Keyset by (code, id): the page starts after the row the cursor names.
      const cursor = await tx.catalogBusinessActivity.findFirst({
        where: { marketId: market.marketId, id: query.afterId },
        select: { code: true },
      });
      if (cursor === null) return { items: [], nextAfterId: null };
      filters.push({
        OR: [{ code: { gt: cursor.code } }, { code: cursor.code, id: { gt: query.afterId } }],
      });
    }
    const rows = await tx.catalogBusinessActivity.findMany({
      where: { marketId: market.marketId, AND: filters },
      include: ACTIVITY_INCLUDE,
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(activityStateOf),
      nextAfterId:
        rows.length > query.limit ? (page[page.length - 1]!.id as Id<'BusinessActivity'>) : null,
    };
  }
}
