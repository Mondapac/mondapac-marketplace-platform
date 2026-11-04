import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  SavedFilterRepository,
  SavedFilterWrite,
} from '../application/ports/saved-filter.repository';
import {
  MAX_SAVED_FILTERS_PER_OWNER,
  MAX_SHARED_SAVED_FILTERS,
  type SavedFilter,
  type SavedFilterVisibility,
} from '../domain/saved-filter';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** The two case-insensitive name uniques of the migration (data design 3.28). */
const UNIQUE_OWNER_NAME = 'saved_filters_owner_name_key';
const UNIQUE_SHARED_NAME = 'saved_filters_shared_name_key';

type Row = Prisma.CatalogSavedFilterGetPayload<object>;

const filterOf = (row: Row): SavedFilter => ({
  id: row.id as Id<'SavedFilter'>,
  listKey: row.listKey,
  ownerAccountId: row.ownerAccountId as Id<'Account'>,
  visibility: row.visibility as SavedFilterVisibility,
  name: row.name,
  payload: row.payload,
  position: row.position,
  createdAt: toInstant(row.createdAt),
  updatedAt: toInstant(row.updatedAt),
});

/**
 * {@link SavedFilterRepository} on `catalog.saved_filters`. Every statement goes through
 * `PrismaService.tx(market)` with `marketId` in `where`, so another Market's rows are never read
 * or changed.
 */
export class PrismaSavedFilterRepository implements SavedFilterRepository {
  constructor(private readonly prisma: PrismaService) {}

  async visibleTo(
    market: MarketContext,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<readonly SavedFilter[]> {
    const rows = await this.prisma.tx(market).catalogSavedFilter.findMany({
      where: {
        marketId: market.marketId,
        listKey,
        OR: [{ ownerAccountId: accountId }, { visibility: 'everyone' }],
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      // Both caps bound the rows; the extra room covers a cap lowered after rows were written.
      take: 2 * (MAX_SAVED_FILTERS_PER_OWNER + MAX_SHARED_SAVED_FILTERS),
    });
    return rows.map(filterOf);
  }

  async find(market: MarketContext, id: Id<'SavedFilter'>): Promise<SavedFilter | null> {
    const row = await this.prisma.tx(market).catalogSavedFilter.findFirst({
      where: { marketId: market.marketId, id },
    });
    return row === null ? null : filterOf(row);
  }

  countOwnedBy(market: MarketContext, listKey: string, accountId: Id<'Account'>): Promise<number> {
    return this.prisma.tx(market).catalogSavedFilter.count({
      where: { marketId: market.marketId, listKey, ownerAccountId: accountId },
    });
  }

  countShared(market: MarketContext, listKey: string): Promise<number> {
    return this.prisma.tx(market).catalogSavedFilter.count({
      where: { marketId: market.marketId, listKey, visibility: 'everyone' },
    });
  }

  async nextPosition(
    market: MarketContext,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<number> {
    const last = await this.prisma.tx(market).catalogSavedFilter.aggregate({
      where: { marketId: market.marketId, listKey, ownerAccountId: accountId },
      _max: { position: true },
    });
    return (last._max.position ?? 0) + 1;
  }

  async add(market: MarketContext, filter: SavedFilter): Promise<SavedFilterWrite> {
    try {
      await this.prisma.tx(market).catalogSavedFilter.create({
        data: {
          id: filter.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          ownerAccountId: filter.ownerAccountId,
          visibility: filter.visibility,
          listKey: filter.listKey,
          name: filter.name,
          payload: filter.payload as Prisma.InputJsonValue,
          position: filter.position,
          createdAt: toDate(filter.createdAt),
          updatedAt: toDate(filter.updatedAt),
        },
        select: { id: true },
      });
    } catch (error) {
      if (this.#nameTaken(error)) return 'name-taken';
      throw error;
    }
    return 'ok';
  }

  async change(market: MarketContext, filter: SavedFilter): Promise<SavedFilterWrite | 'gone'> {
    try {
      const changed = await this.prisma.tx(market).catalogSavedFilter.updateMany({
        where: { marketId: market.marketId, id: filter.id },
        data: {
          name: filter.name,
          visibility: filter.visibility,
          updatedAt: toDate(filter.updatedAt),
        },
      });
      return changed.count === 0 ? 'gone' : 'ok';
    } catch (error) {
      if (this.#nameTaken(error)) return 'name-taken';
      throw error;
    }
  }

  async remove(market: MarketContext, id: Id<'SavedFilter'>): Promise<boolean> {
    const removed = await this.prisma.tx(market).catalogSavedFilter.deleteMany({
      where: { marketId: market.marketId, id },
    });
    return removed.count > 0;
  }

  #nameTaken(error: unknown): boolean {
    const unique = this.prisma.violatedConstraint(error);
    return unique === UNIQUE_OWNER_NAME || unique === UNIQUE_SHARED_NAME;
  }
}
