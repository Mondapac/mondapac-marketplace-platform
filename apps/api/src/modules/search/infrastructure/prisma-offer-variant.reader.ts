import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  MAX_GTIN_UNITS,
  type GtinUnit,
  type HitSellUnits,
  type OfferVariantReader,
} from '../application/ports/offer-variant.reader';
import type { OfferHit, OfferVariantDocument } from '../domain/offer-document';

/** {@link OfferVariantReader} over the search tables, by `(market_id, ...)`; no join. */
export class PrismaOfferVariantReader implements OfferVariantReader {
  constructor(private readonly prisma: PrismaService) {}

  async sellUnitsOf(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, HitSellUnits>> {
    const result = new Map<Id<'Offer'>, HitSellUnits>();
    const ids = [...new Set(offerIds)];
    if (ids.length === 0) return result;
    const tx = this.prisma.tx(market);
    const [documents, rows] = await Promise.all([
      tx.searchOfferDocument.findMany({
        where: { marketId: market.marketId, offerId: { in: ids } },
        select: { offerId: true, facetCodes: true },
      }),
      tx.searchOfferVariantDocument.findMany({
        where: { marketId: market.marketId, offerId: { in: ids } },
        select: {
          offerId: true,
          variantId: true,
          position: true,
          facetCodes: true,
          gtin: true,
          inStock: true,
          priceAmount: true,
          priceCurrency: true,
        },
        orderBy: [{ offerId: 'asc' }, { position: 'asc' }, { variantId: 'asc' }],
      }),
    ]);
    const byOffer = new Map<string, OfferVariantDocument[]>();
    for (const row of rows) {
      const list = byOffer.get(row.offerId) ?? [];
      list.push({
        variantId: row.variantId as Id<'Variant'>,
        position: row.position,
        facetCodes: row.facetCodes,
        gtin: row.gtin,
        inStock: row.inStock,
        price:
          row.priceAmount === null || row.priceCurrency === null
            ? null
            : { amount: row.priceAmount, currency: row.priceCurrency },
      });
      byOffer.set(row.offerId, list);
    }
    for (const document of documents) {
      result.set(document.offerId as Id<'Offer'>, {
        facetCodes: document.facetCodes,
        variants: byOffer.get(document.offerId) ?? [],
      });
    }
    return result;
  }

  async unitsWithGtin(market: MarketContext, gtin: string): Promise<readonly GtinUnit[]> {
    const rows = await this.prisma.tx(market).searchOfferVariantDocument.findMany({
      where: { marketId: market.marketId, gtin },
      select: { offerId: true, variantId: true },
      orderBy: [{ offerId: 'asc' }, { variantId: 'asc' }],
      take: MAX_GTIN_UNITS,
    });
    return rows.map((row) => ({
      offerId: row.offerId as Id<'Offer'>,
      variantId: row.variantId as Id<'Variant'>,
    }));
  }

  async hitsOf(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<readonly OfferHit[]> {
    const ids = [...new Set(offerIds)];
    if (ids.length === 0) return [];
    const rows = await this.prisma.tx(market).searchOfferDocument.findMany({
      where: { marketId: market.marketId, offerId: { in: ids } },
      select: {
        offerId: true,
        productId: true,
        sellerId: true,
        name: true,
        shortText: true,
        categoryIds: true,
      },
      orderBy: { offerId: 'asc' },
    });
    return rows.map((row) => ({
      offerId: row.offerId as Id<'Offer'>,
      productId: row.productId as Id<'Product'>,
      sellerId: row.sellerId as Id<'Seller'>,
      name: row.name,
      shortText: row.shortText,
      categoryIds: row.categoryIds as Id<'Category'>[],
      rank: 0,
    }));
  }
}
