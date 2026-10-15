import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { OfferDocumentRepository } from '../application/ports/offer-document.repository';
import type { OfferDocument } from '../domain/offer-document';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/**
 * {@link OfferDocumentRepository} over Prisma models. The tsvector is never written here: the
 * trigger `offer_documents_set_vector` builds it from the row's name, short text and
 * configuration. The Market and tenant come from the unit (the market guard fills and checks them).
 */
export class PrismaOfferDocumentRepository implements OfferDocumentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async upsert(
    market: MarketContext,
    document: OfferDocument,
    indexedAt: Temporal.Instant,
  ): Promise<void> {
    const data = {
      productId: document.productId,
      sellerId: document.sellerId,
      locale: document.locale,
      name: document.name,
      shortText: document.shortText,
      categoryIds: [...document.categoryIds],
      textSearchConfig: document.textSearchConfig,
      indexedAt: toDate(indexedAt),
    };
    await this.prisma.tx(market).searchOfferDocument.upsert({
      where: {
        marketId: market.marketId,
        marketId_offerId: { marketId: market.marketId, offerId: document.offerId },
      },
      create: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        offerId: document.offerId,
        ...data,
      },
      update: data,
    });
  }

  async deleteMany(market: MarketContext, offerIds: readonly Id<'Offer'>[]): Promise<number> {
    if (offerIds.length === 0) return 0;
    const { count } = await this.prisma.tx(market).searchOfferDocument.deleteMany({
      where: { marketId: market.marketId, offerId: { in: [...offerIds] } },
    });
    return count;
  }

  async offerIdsOfProduct(
    market: MarketContext,
    productId: Id<'Product'>,
  ): Promise<readonly Id<'Offer'>[]> {
    const rows = await this.prisma.tx(market).searchOfferDocument.findMany({
      where: { marketId: market.marketId, productId },
      select: { offerId: true },
    });
    return rows.map((row) => row.offerId as Id<'Offer'>);
  }

  async deleteIndexedBefore(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<number> {
    const stale = await this.prisma.tx(market).searchOfferDocument.findMany({
      where: { marketId: market.marketId, indexedAt: { lt: toDate(before) } },
      select: { offerId: true },
      orderBy: { offerId: 'asc' },
      take: limit,
    });
    if (stale.length === 0) return 0;
    const { count } = await this.prisma.tx(market).searchOfferDocument.deleteMany({
      where: {
        marketId: market.marketId,
        indexedAt: { lt: toDate(before) },
        offerId: { in: stale.map((row) => row.offerId) },
      },
    });
    return count;
  }
}
