import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { StoreDocumentRepository } from '../application/ports/store-document.repository';
import type { StoreDocument } from '../domain/store-document';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/**
 * {@link StoreDocumentRepository} over Prisma. The tsvector is never written here: the trigger
 * `store_documents_set_vector` builds it from the name. The Market and tenant come from the unit
 * (the market guard fills and checks them).
 */
export class PrismaStoreDocumentRepository implements StoreDocumentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async upsertMany(
    market: MarketContext,
    documents: readonly StoreDocument[],
    indexedAt: Temporal.Instant,
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    for (const document of documents) {
      const data = {
        slug: document.slug,
        name: document.name,
        textSearchConfig: document.textSearchConfig,
        indexedAt: toDate(indexedAt),
      };
      // A slug names one store: when it moved to another seller, the old holder's row goes first
      // (sellers re-checks held addresses; the old row is stale by then).
      await tx.searchStoreDocument.deleteMany({
        where: {
          marketId: market.marketId,
          slug: document.slug,
          sellerId: { not: document.sellerId },
        },
      });
      await tx.searchStoreDocument.upsert({
        where: {
          marketId: market.marketId,
          marketId_sellerId: { marketId: market.marketId, sellerId: document.sellerId },
        },
        create: {
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId: document.sellerId,
          ...data,
        },
        update: data,
      });
    }
  }

  async deleteMany(market: MarketContext, sellerIds: readonly Id<'Seller'>[]): Promise<number> {
    if (sellerIds.length === 0) return 0;
    const { count } = await this.prisma.tx(market).searchStoreDocument.deleteMany({
      where: { marketId: market.marketId, sellerId: { in: [...sellerIds] } },
    });
    return count;
  }

  async deleteIndexedBefore(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<number> {
    const tx = this.prisma.tx(market);
    const stale = await tx.searchStoreDocument.findMany({
      where: { marketId: market.marketId, indexedAt: { lt: toDate(before) } },
      select: { sellerId: true },
      orderBy: { sellerId: 'asc' },
      take: limit,
    });
    if (stale.length === 0) return 0;
    const { count } = await tx.searchStoreDocument.deleteMany({
      where: {
        marketId: market.marketId,
        sellerId: { in: stale.map((row) => row.sellerId) },
      },
    });
    return count;
  }

  async offerCounts(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, number>> {
    if (sellerIds.length === 0) return new Map();
    const rows = await this.prisma.tx(market).searchOfferDocument.groupBy({
      by: ['sellerId'],
      where: { marketId: market.marketId, sellerId: { in: [...sellerIds] } },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.sellerId as Id<'Seller'>, row._count._all]));
  }
}
