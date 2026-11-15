import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  ColumnPreferenceStore,
  StoredColumnPreference,
} from '../contracts/column-preference-store';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/**
 * {@link ColumnPreferenceStore} on `lists.column_preferences`. Every statement goes through
 * `PrismaService.tx(market)` with `marketId` and `sellerId` in `where` (`sellerId: null` matches
 * only the rows that have no store).
 */
export class PrismaColumnPreferenceStore implements ColumnPreferenceStore {
  constructor(private readonly prisma: PrismaService) {}

  async find(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<StoredColumnPreference | null> {
    const row = await this.prisma.tx(market).listsColumnPreference.findFirst({
      where: { marketId: market.marketId, sellerId, listKey, ownerAccountId: accountId },
    });
    if (row === null) return null;
    return {
      id: row.id as Id<'ColumnPreference'>,
      listKey: row.listKey,
      ownerAccountId: row.ownerAccountId as Id<'Account'>,
      sellerId: row.sellerId === null ? null : (row.sellerId as Id<'Seller'>),
      columns: (row.columns as unknown[]).filter((id): id is string => typeof id === 'string'),
      createdAt: toInstant(row.createdAt),
      updatedAt: toInstant(row.updatedAt),
    };
  }

  async put(market: MarketContext, preference: StoredColumnPreference): Promise<void> {
    const client = this.prisma.tx(market);
    const changed = await client.listsColumnPreference.updateMany({
      where: {
        marketId: market.marketId,
        sellerId: preference.sellerId,
        listKey: preference.listKey,
        ownerAccountId: preference.ownerAccountId,
      },
      data: { columns: [...preference.columns], updatedAt: toDate(preference.updatedAt) },
    });
    if (changed.count > 0) return;
    // A concurrent first save of the same choice collides on the unique index; the unit is
    // serializable, so the platform retries it and the second attempt updates.
    await client.listsColumnPreference.create({
      data: {
        id: preference.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        ownerAccountId: preference.ownerAccountId,
        sellerId: preference.sellerId,
        listKey: preference.listKey,
        columns: [...preference.columns],
        createdAt: toDate(preference.createdAt),
        updatedAt: toDate(preference.updatedAt),
      },
    });
  }

  async remove(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    listKey: string,
    accountId: Id<'Account'>,
  ): Promise<void> {
    await this.prisma.tx(market).listsColumnPreference.deleteMany({
      where: { marketId: market.marketId, sellerId, listKey, ownerAccountId: accountId },
    });
  }
}
