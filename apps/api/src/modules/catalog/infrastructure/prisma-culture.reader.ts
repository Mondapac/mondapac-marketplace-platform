import type { MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { CultureListQuery, CultureReader } from '../application/ports/culture.reader';
import type { CultureState } from '../domain/culture';
import { CULTURE_INCLUDE, cultureStateOf } from './prisma-culture.repository';

/** {@link CultureReader} on the culture tables; every statement carries the Market. */
export class PrismaCultureReader implements CultureReader {
  constructor(private readonly prisma: PrismaService) {}

  async list(market: MarketContext, query: CultureListQuery): Promise<readonly CultureState[]> {
    const filters: Prisma.CatalogCultureWhereInput[] = [];
    if (query.status !== null) filters.push({ status: query.status });
    if (query.search !== null) {
      filters.push({
        OR: [
          { code: { contains: query.search.toLowerCase() } },
          { names: { some: { name: { contains: query.search, mode: 'insensitive' } } } },
        ],
      });
    }
    const rows = await this.prisma.tx(market).catalogCulture.findMany({
      where: { marketId: market.marketId, AND: filters },
      include: CULTURE_INCLUDE,
      orderBy: [{ displayOrder: 'asc' }, { code: 'asc' }, { id: 'asc' }],
      take: 200,
    });
    return rows.map(cultureStateOf);
  }
}
