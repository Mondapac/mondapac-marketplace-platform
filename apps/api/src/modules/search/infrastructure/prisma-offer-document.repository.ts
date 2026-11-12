import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { OfferDocumentRepository } from '../application/ports/offer-document.repository';
import type { OfferDocument } from '../domain/offer-document';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/**
 * {@link OfferDocumentRepository} over Prisma models. The tsvector is never written here: the
 * trigger `offer_documents_set_vector` builds it from the row's name, short text and
 * configuration. The numbers and the sell units (V8) are replaced as sets with the document. The Market and tenant come from the unit (the market guard fills and checks them).
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
      searchText: document.searchText,
      facetCodes: [...document.facetCodes],
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
    // The numbers are replaced as a set: the document's own rows go, the current ones come.
    const tx = this.prisma.tx(market);
    await tx.searchOfferDocumentNumber.deleteMany({
      where: { marketId: market.marketId, offerId: document.offerId },
    });
    const rows = Object.entries(document.numbers).map(([attr, value]) => ({
      marketId: market.marketId,
      tenantId: market.tenantId,
      offerId: document.offerId,
      attr,
      value,
    }));
    if (rows.length > 0) await tx.searchOfferDocumentNumber.createMany({ data: rows });
    // The sell units (V8), replaced as a set the same way.
    await tx.searchOfferVariantDocument.deleteMany({
      where: { marketId: market.marketId, offerId: document.offerId },
    });
    const units = document.variants.map((variant) => ({
      marketId: market.marketId,
      tenantId: market.tenantId,
      offerId: document.offerId,
      variantId: variant.variantId,
      position: variant.position,
      facetCodes: [...variant.facetCodes],
      gtin: variant.gtin,
      inStock: variant.inStock,
      priceAmount: variant.price?.amount ?? null,
      priceCurrency: variant.price?.currency ?? null,
    }));
    if (units.length > 0) await tx.searchOfferVariantDocument.createMany({ data: units });
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

  async offerIdsOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<readonly Id<'Offer'>[]> {
    const rows = await this.prisma.tx(market).searchOfferDocument.findMany({
      where: { marketId: market.marketId, sellerId },
      select: { offerId: true },
    });
    return rows.map((row) => row.offerId as Id<'Offer'>);
  }

  async offerIdsInCategories(
    market: MarketContext,
    categoryIds: readonly Id<'Category'>[],
  ): Promise<readonly Id<'Offer'>[]> {
    const rows = await this.prisma.tx(market).searchOfferDocument.findMany({
      where: { marketId: market.marketId, categoryIds: { hasSome: [...categoryIds] } },
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
