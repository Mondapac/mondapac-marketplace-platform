import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  MAX_SAVED_FILTERS_PER_OWNER,
  MAX_SHARED_SAVED_FILTERS,
  type SavedFilterStore,
  type StoredFilter,
  type StoredFilterVisibility,
  type StoredFilterWrite,
} from '../contracts/saved-filter-store';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** The four case-insensitive name uniques of the migration: admin and store twins. */
const UNIQUES = new Set([
  'saved_filters_owner_name_key',
  'saved_filters_shared_name_key',
  'saved_filters_seller_owner_name_key',
  'saved_filters_seller_shared_name_key',
]);

type Row = Prisma.ListsSavedFilterGetPayload<object>;

const filterOf = (row: Row): StoredFilter => ({
  id: row.id as Id<'SavedFilter'>,
  listKey: row.listKey,
  ownerAccountId: row.ownerAccountId as Id<'Account'>,
  sellerId: row.sellerId === null ? null : (row.sellerId as Id<'Seller'>),
  visibility: row.visibility as StoredFilterVisibility,
  name: row.name,
  payload: row.payload,
  position: row.position,
  createdAt: toInstant(row.createdAt),
  updatedAt: toInstant(row.updatedAt),
});

/**
 * {@link SavedFilterStore} on `lists.saved_filters`. Every statement goes through
 * `PrismaService.tx(market)` with `marketId` and `sellerId` in `where` (`sellerId: null` matches
 * only the rows that have no store), so another Market's or another store's rows are never read
 * or changed.
 */
export class PrismaSavedFilterStore implements SavedFilterStore {
  constructor(private readonly prisma: PrismaService) {}

  async visibleTo(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<readonly StoredFilter[]> {
    const rows = await this.prisma.tx(market).listsSavedFilter.findMany({
      where: {
        marketId: market.marketId,
        sellerId,
        listKey,
        OR: [{ ownerAccountId: accountId }, { visibility: 'everyone' }],
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      // Both caps bound the rows; the extra room covers a cap lowered after rows were written.
      take: 2 * (MAX_SAVED_FILTERS_PER_OWNER + MAX_SHARED_SAVED_FILTERS),
    });
    return rows.map(filterOf);
  }

  async find(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    id: Id<'SavedFilter'>,
  ): Promise<StoredFilter | null> {
    const row = await this.prisma.tx(market).listsSavedFilter.findFirst({
      where: { marketId: market.marketId, sellerId, id },
    });
    return row === null ? null : filterOf(row);
  }

  countOwnedBy(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<number> {
    return this.prisma.tx(market).listsSavedFilter.count({
      where: { marketId: market.marketId, sellerId, listKey, ownerAccountId: accountId },
    });
  }

  countShared(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKey: string,
  ): Promise<number> {
    return this.prisma.tx(market).listsSavedFilter.count({
      where: { marketId: market.marketId, sellerId, listKey, visibility: 'everyone' },
    });
  }

  async nextPosition(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<number> {
    const last = await this.prisma.tx(market).listsSavedFilter.aggregate({
      where: { marketId: market.marketId, sellerId, listKey, ownerAccountId: accountId },
      _max: { position: true },
    });
    return (last._max.position ?? 0) + 1;
  }

  async add(market: MarketContext, filter: StoredFilter): Promise<StoredFilterWrite> {
    try {
      await this.prisma.tx(market).listsSavedFilter.create({
        data: {
          id: filter.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          ownerAccountId: filter.ownerAccountId,
          sellerId: filter.sellerId,
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

  async change(market: MarketContext, filter: StoredFilter): Promise<StoredFilterWrite | 'gone'> {
    try {
      const changed = await this.prisma.tx(market).listsSavedFilter.updateMany({
        where: { marketId: market.marketId, sellerId: filter.sellerId, id: filter.id },
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

  async remove(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    id: Id<'SavedFilter'>,
  ): Promise<boolean> {
    const removed = await this.prisma.tx(market).listsSavedFilter.deleteMany({
      where: { marketId: market.marketId, sellerId, id },
    });
    return removed.count > 0;
  }

  #nameTaken(error: unknown): boolean {
    const unique = this.prisma.violatedConstraint(error);
    return unique !== null && UNIQUES.has(unique);
  }
}
