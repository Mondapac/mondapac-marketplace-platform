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
    categoryIds: readonly Id<'Category'>[] | null,
    limit: number,
    offset: number,
  ): Promise<readonly OfferHit[]> {
    const rows = await this.prisma.tx(market).searchOfferDocument.findMany({
      where: {
        marketId: market.marketId,
        sellerId,
        ...(categoryIds === null ? {} : { categoryIds: { hasSome: [...categoryIds] } }),
      },
      orderBy: [{ name: 'asc' }, { offerId: 'asc' }],
      skip: offset,
      take: limit,
      select: SELECT,
    });
    return rows.map(hitOf);
  }

  async byProductIds(
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
    perProduct: number,
  ): Promise<readonly OfferHit[]> {
    // One indexed query per product (at most 50): a `take` over all of them would cut the
    // products that sort last. They run in the caller's unit, one after the other.
    const hits: OfferHit[] = [];
    for (const productId of new Set(productIds)) {
      hits.push(...(await this.byProductId(market, productId, perProduct)));
    }
    return hits;
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
