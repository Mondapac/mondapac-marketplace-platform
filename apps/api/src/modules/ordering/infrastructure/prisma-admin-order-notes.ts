import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  AdminOrderNoteRepository,
  StoredAdminNote,
} from '../application/ports/admin-order-notes';

/** {@link AdminOrderNoteRepository} on `ordering.admin_order_notes`, `marketId` in every `where`. */
export class PrismaAdminOrderNoteRepository implements AdminOrderNoteRepository {
  constructor(private readonly prisma: PrismaService) {}

  async orderAccount(market: MarketContext, orderId: Id<'Order'>) {
    const row = await this.prisma.tx(market).orderingOrder.findFirst({
      where: { marketId: market.marketId, id: orderId },
      select: { accountId: true },
    });
    return row === null ? null : (row.accountId as Id<'Account'>);
  }

  async insert(market: MarketContext, note: StoredAdminNote): Promise<void> {
    await this.prisma.tx(market).orderingAdminOrderNote.create({
      data: {
        id: note.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        orderId: note.orderId,
        authorAccountId: note.authorAccountId,
        bodyCiphertext: note.bodySealed,
        createdAt: new Date(note.createdAt.epochMilliseconds),
      },
    });
  }

  async list(
    market: MarketContext,
    orderId: Id<'Order'>,
    limit: number,
  ): Promise<readonly StoredAdminNote[]> {
    const rows = await this.prisma.tx(market).orderingAdminOrderNote.findMany({
      where: { marketId: market.marketId, orderId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id as Id<'AdminOrderNote'>,
      orderId: row.orderId as Id<'Order'>,
      authorAccountId: row.authorAccountId as Id<'Account'>,
      bodySealed: row.bodyCiphertext,
      createdAt: Temporal.Instant.fromEpochMilliseconds(row.createdAt.getTime()),
    }));
  }
}
