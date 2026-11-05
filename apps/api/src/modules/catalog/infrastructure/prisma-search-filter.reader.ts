import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { FilterBrand, SearchFilterReader } from '../application/ports/search-filter.reader';
import type { LoadedSearchDefinition } from '../domain/search-attributes';
import { loadSearchDefinitions } from './search-definitions.loader';

/** {@link SearchFilterReader} over Prisma: the shared definition loader and the brand table. */
export class PrismaSearchFilterReader implements SearchFilterReader {
  constructor(private readonly prisma: PrismaService) {}

  definitions(
    market: MarketContext,
    codes: readonly string[],
  ): Promise<ReadonlyMap<string, LoadedSearchDefinition>> {
    return loadSearchDefinitions(this.prisma.tx(market), market.marketId, codes);
  }

  async brands(market: MarketContext, slugs: readonly string[]): Promise<readonly FilterBrand[]> {
    if (slugs.length === 0) return [];
    // Brands are shared by every Market; only active ones are named.
    return this.prisma.tx(market).catalogBrand.findMany({
      where: { slug: { in: [...slugs] }, status: 'active' },
      select: { slug: true, name: true },
      orderBy: { slug: 'asc' },
    });
  }
}
