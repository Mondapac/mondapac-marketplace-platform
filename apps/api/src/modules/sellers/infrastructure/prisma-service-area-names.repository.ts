import type { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  EditedAreaName,
  ServiceAreaNamesRepository,
} from '../application/ports/service-area-names.repository';

/** {@link ServiceAreaNamesRepository} on `sellers.service_area_names`, scoped by the Market. */
export class PrismaServiceAreaNamesRepository implements ServiceAreaNamesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async all(market: MarketContext): Promise<readonly EditedAreaName[]> {
    const rows = await this.prisma.tx(market).sellersServiceAreaName.findMany({
      where: { marketId: market.marketId },
      orderBy: [{ areaCode: 'asc' }, { locale: 'asc' }],
      select: { areaCode: true, locale: true, name: true },
    });
    return rows;
  }

  async apply(
    market: MarketContext,
    areaCode: string,
    changes: ReadonlyMap<string, string | null>,
    by: Id<'Account'>,
    at: Temporal.Instant,
  ): Promise<number> {
    const names = this.prisma.tx(market).sellersServiceAreaName;
    const updatedAt = new Date(at.epochMilliseconds);
    let changed = 0;
    for (const [locale, name] of changes) {
      const where = { marketId: market.marketId, areaCode, locale };
      if (name === null) {
        changed += (await names.deleteMany({ where })).count;
        continue;
      }
      const updated = await names.updateMany({
        where: { ...where, NOT: { name } },
        data: { name, updatedBy: by, updatedAt },
      });
      if (updated.count > 0) {
        changed += 1;
        continue;
      }
      const created = await names.createMany({
        data: [{ ...where, tenantId: market.tenantId, name, updatedBy: by, updatedAt }],
        skipDuplicates: true,
      });
      changed += created.count;
    }
    return changed;
  }
}
