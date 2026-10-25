import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  ConfirmedOrderPage,
  OfferPairStore,
  OrderCursor,
} from '../application/ports/offer-pairs.store';
import type { DirectedOfferPair } from '../domain/offer-pairs';

/** Rows per insert statement: well under PostgreSQL's 65535 bind-parameter limit (6 columns). */
const INSERT_CHUNK = 5000;

/**
 * {@link OfferPairStore} over `ordering.orders`, `ordering.order_lines` and `ordering.offer_pairs`
 * through the Market-scoped client (all one module, `market_id` first in every filter).
 */
export class PrismaOfferPairStore implements OfferPairStore {
  constructor(private readonly prisma: PrismaService) {}

  async confirmedOrders(
    market: MarketContext,
    window: { readonly since: Temporal.Instant; readonly until: Temporal.Instant },
    after: OrderCursor | null,
    take: number,
  ): Promise<ConfirmedOrderPage> {
    const since = new Date(window.since.epochMilliseconds);
    const until = new Date(window.until.epochMilliseconds);
    const rows = await this.prisma.tx(market).orderingOrder.findMany({
      where: {
        marketId: market.marketId,
        status: 'confirmed',
        confirmedAt: { gte: since, lte: until },
        // Keyset `(confirmed_at, id) > (cursor)`, served by the partial index of
        // `orders_market_id_confirmed_at_id_idx`.
        ...(after === null
          ? {}
          : {
              OR: [
                { confirmedAt: { gt: new Date(after.confirmedAt.epochMilliseconds), lte: until } },
                {
                  confirmedAt: new Date(after.confirmedAt.epochMilliseconds),
                  id: { gt: after.orderId },
                },
              ],
            }),
      },
      select: {
        id: true,
        confirmedAt: true,
        lines: { where: { marketId: market.marketId }, select: { offerId: true } },
      },
      orderBy: [{ confirmedAt: 'asc' }, { id: 'asc' }],
      take,
    });
    return {
      orders: rows.map((row) => {
        if (row.confirmedAt === null) throw new Error('A confirmed order without its time');
        return {
          orderId: row.id,
          confirmedAt: Temporal.Instant.fromEpochMilliseconds(row.confirmedAt.getTime()),
          offerIds: row.lines.map((line) => line.offerId),
        };
      }),
    };
  }

  async replacePairs(
    market: MarketContext,
    pairs: readonly DirectedOfferPair[],
    computedAt: Temporal.Instant,
  ): Promise<number> {
    const tx = this.prisma.tx(market);
    await tx.orderingOfferPair.deleteMany({ where: { marketId: market.marketId } });
    const stamp = new Date(computedAt.epochMilliseconds);
    const rows = pairs.map((pair) => ({
      marketId: market.marketId,
      tenantId: market.tenantId,
      offerId: pair.offerId,
      pairedOfferId: pair.pairedOfferId,
      orders: pair.orders,
      computedAt: stamp,
    }));
    for (let at = 0; at < rows.length; at += INSERT_CHUNK) {
      await tx.orderingOfferPair.createMany({ data: rows.slice(at, at + INSERT_CHUNK) });
    }
    return rows.length;
  }

  async partnersOf(
    market: MarketContext,
    offerId: Id<'Offer'>,
    limit: number,
  ): Promise<readonly Id<'Offer'>[]> {
    const rows = await this.prisma.tx(market).orderingOfferPair.findMany({
      where: { marketId: market.marketId, offerId },
      select: { pairedOfferId: true },
      orderBy: [{ orders: 'desc' }, { pairedOfferId: 'asc' }],
      take: limit,
    });
    return rows.map((row) => row.pairedOfferId as Id<'Offer'>);
  }
}
