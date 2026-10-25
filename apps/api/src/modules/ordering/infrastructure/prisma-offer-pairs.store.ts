import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { ConfirmedOrderPage, OfferPairStore } from '../application/ports/offer-pairs.store';
import type { OfferPairCount } from '../domain/offer-pairs';

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
    since: Temporal.Instant,
    afterOrderId: string | null,
    take: number,
  ): Promise<ConfirmedOrderPage> {
    const rows = await this.prisma.tx(market).orderingOrder.findMany({
      where: {
        marketId: market.marketId,
        status: 'confirmed',
        confirmedAt: { gte: new Date(since.epochMilliseconds) },
        ...(afterOrderId === null ? {} : { id: { gt: afterOrderId } }),
      },
      select: {
        id: true,
        lines: { where: { marketId: market.marketId }, select: { offerId: true } },
      },
      orderBy: { id: 'asc' },
      take,
    });
    return {
      orders: rows.map((row) => ({
        orderId: row.id,
        offerIds: row.lines.map((line) => line.offerId),
      })),
    };
  }

  async replacePairs(
    market: MarketContext,
    pairs: readonly OfferPairCount[],
    computedAt: Temporal.Instant,
  ): Promise<number> {
    const tx = this.prisma.tx(market);
    await tx.orderingOfferPair.deleteMany({ where: { marketId: market.marketId } });
    const stamp = new Date(computedAt.epochMilliseconds);
    const rows = pairs.flatMap((pair) =>
      [
        [pair.offerId, pair.pairedOfferId],
        [pair.pairedOfferId, pair.offerId],
      ].map(([offerId, pairedOfferId]) => ({
        marketId: market.marketId,
        tenantId: market.tenantId,
        offerId: offerId as string,
        pairedOfferId: pairedOfferId as string,
        orders: pair.orders,
        computedAt: stamp,
      })),
    );
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
