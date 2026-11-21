import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import { instantRangeWhere } from '../../../platform/list-query';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  BusinessActivityListPage,
  BusinessActivityListQuery,
  BusinessActivityPageFilter,
  BusinessActivityPageQuery,
  BusinessActivityReader,
} from '../application/ports/business-activity.reader';
import type { BusinessActivityState } from '../domain/business-activity';
import { likeLiteral } from './like-literal';
import { ACTIVITY_INCLUDE, activityStateOf } from './prisma-business-activity.repository';

function activityFilters(
  filter: BusinessActivityPageFilter,
): Prisma.CatalogBusinessActivityWhereInput[] {
  const filters: Prisma.CatalogBusinessActivityWhereInput[] = [];
  if (filter.status !== null) filters.push({ status: filter.status });
  const created = instantRangeWhere({
    from: filter.createdFrom ?? null,
    to: filter.createdTo ?? null,
  });
  if (created !== undefined) filters.push({ createdAt: created });
  if (filter.search !== null) {
    const typed = likeLiteral(filter.search);
    filters.push({
      OR: [
        { code: { contains: typed.toLowerCase() } },
        { names: { some: { name: { contains: typed, mode: 'insensitive' } } } },
      ],
    });
  }
  return filters;
}

/** {@link BusinessActivityReader} on the business-activity tables; every statement carries the Market. */
export class PrismaBusinessActivityReader implements BusinessActivityReader {
  constructor(private readonly prisma: PrismaService) {}

  async activeIds(
    market: MarketContext,
    ids: readonly Id<'BusinessActivity'>[],
  ): Promise<ReadonlySet<Id<'BusinessActivity'>>> {
    const rows = await this.prisma.tx(market).catalogBusinessActivity.findMany({
      where: { marketId: market.marketId, id: { in: [...ids] }, status: 'active' },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id as Id<'BusinessActivity'>));
  }

  async page(
    market: MarketContext,
    query: BusinessActivityPageQuery,
  ): Promise<readonly BusinessActivityState[]> {
    const field = { code: 'code', status: 'status', created: 'createdAt', updated: 'updatedAt' }[
      query.sort
    ] as 'code' | 'status' | 'createdAt' | 'updatedAt';
    const rows = await this.prisma.tx(market).catalogBusinessActivity.findMany({
      where: { marketId: market.marketId, AND: activityFilters(query) },
      include: ACTIVITY_INCLUDE,
      orderBy: [{ [field]: query.direction }, { id: query.direction }],
      skip: query.offset,
      take: query.limit,
    });
    return rows.map(activityStateOf);
  }

  async count(market: MarketContext, filter: BusinessActivityPageFilter): Promise<number> {
    return this.prisma.tx(market).catalogBusinessActivity.count({
      where: { marketId: market.marketId, AND: activityFilters(filter) },
    });
  }

  async list(
    market: MarketContext,
    query: BusinessActivityListQuery,
  ): Promise<BusinessActivityListPage> {
    const tx = this.prisma.tx(market);
    const filters = activityFilters(query);
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
