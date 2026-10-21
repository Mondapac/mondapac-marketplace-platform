import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { ShelfDocumentsReader } from '../application/ports/shelf-documents.reader';
import type { OfferHit } from '../domain/offer-document';

const SELECT = {
  offerId: true,
  productId: true,
  sellerId: true,
  name: true,
  shortText: true,
  categoryIds: true,
} as const;

type Row = {
  offerId: string;
  productId: string;
  sellerId: string;
  name: string;
  shortText: string | null;
  categoryIds: string[];
};

const hitOf = (row: Row): OfferHit => ({
  offerId: row.offerId as Id<'Offer'>,
  productId: row.productId as Id<'Product'>,
  sellerId: row.sellerId as Id<'Seller'>,
  name: row.name,
  shortText: row.shortText,
  categoryIds: row.categoryIds as Id<'Category'>[],
  rank: 0,
});

/** {@link ShelfDocumentsReader} on `search.offer_documents`, `market_id` first in every `where`. */
export class PrismaShelfDocumentsReader implements ShelfDocumentsReader {
  constructor(private readonly prisma: PrismaService) {}

  async byOfferIds(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<readonly OfferHit[]> {
    if (offerIds.length === 0) return [];
    const rows = await this.prisma.tx(market).searchOfferDocument.findMany({
      where: { marketId: market.marketId, offerId: { in: [...offerIds] } },
      select: SELECT,
    });
    return rows.map(hitOf);
  }

  async byProductId(
    market: MarketContext,
    productId: Id<'Product'>,
    limit: number,
  ): Promise<readonly OfferHit[]> {
    const rows = await this.prisma.tx(market).searchOfferDocument.findMany({
      where: { marketId: market.marketId, productId },
      orderBy: [{ offerId: 'asc' }],
      take: limit,
      select: SELECT,
    });
    return rows.map(hitOf);
  }

  async browseBySeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    categoryId: Id<'Category'> | null,
    limit: number,
    offset: number,
  ): Promise<readonly OfferHit[]> {
    const rows = await this.prisma.tx(market).searchOfferDocument.findMany({
      where: {
        marketId: market.marketId,
        sellerId,
        ...(categoryId === null ? {} : { categoryIds: { has: categoryId } }),
      },
      orderBy: [{ name: 'asc' }, { offerId: 'asc' }],
      skip: offset,
      take: limit,
      select: SELECT,
    });
    return rows.map(hitOf);
  }

  async browseAll(market: MarketContext, limit: number): Promise<readonly OfferHit[]> {
    const rows = await this.prisma.tx(market).searchOfferDocument.findMany({
      where: { marketId: market.marketId },
      orderBy: [{ name: 'asc' }, { offerId: 'asc' }],
      take: limit,
      select: SELECT,
    });
    return rows.map(hitOf);
  }
}
