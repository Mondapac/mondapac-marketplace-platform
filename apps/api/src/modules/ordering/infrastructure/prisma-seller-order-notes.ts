import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  SellerOrderNoteRepository,
  StoredSellerNote,
} from '../application/ports/seller-order-notes';

/**
 * {@link SellerOrderNoteRepository} on `ordering.seller_order_notes`, `marketId` and the seller in
 * every `where`.
 */
export class PrismaSellerOrderNoteRepository implements SellerOrderNoteRepository {
  constructor(private readonly prisma: PrismaService) {}

  async sellerOrderOf(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    sellerOrderId: Id<'SellerOrder'>,
  ) {
    const row = await this.prisma.tx(market).orderingSellerOrder.findFirst({
      where: {
        marketId: market.marketId,
        id: sellerOrderId,
        sellerId,
        order: { status: 'confirmed' },
      },
      select: { orderId: true, order: { select: { accountId: true } } },
    });
    return row === null
      ? null
      : { orderId: row.orderId as Id<'Order'>, accountId: row.order.accountId as Id<'Account'> };
  }

  async insert(market: MarketContext, note: StoredSellerNote): Promise<void> {
    await this.prisma.tx(market).orderingSellerOrderNote.create({
      data: {
        id: note.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        orderId: note.orderId,
        sellerOrderId: note.sellerOrderId,
        sellerId: note.sellerId,
        authorAccountId: note.authorAccountId,
        bodyCiphertext: note.bodySealed,
        createdAt: new Date(note.createdAt.epochMilliseconds),
      },
    });
  }

  async list(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    sellerOrderId: Id<'SellerOrder'>,
    limit: number,
  ): Promise<readonly StoredSellerNote[]> {
    const rows = await this.prisma.tx(market).orderingSellerOrderNote.findMany({
      where: { marketId: market.marketId, sellerOrderId, sellerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id as Id<'SellerOrderNote'>,
      orderId: row.orderId as Id<'Order'>,
      sellerOrderId: row.sellerOrderId as Id<'SellerOrder'>,
      sellerId: row.sellerId as Id<'Seller'>,
      authorAccountId: row.authorAccountId as Id<'Account'>,
      bodySealed: row.bodyCiphertext,
      createdAt: Temporal.Instant.fromEpochMilliseconds(row.createdAt.getTime()),
    }));
  }
}
