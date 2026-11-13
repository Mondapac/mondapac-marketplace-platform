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
      cultureCodes: [...document.cultureCodes],
      indexedAt: toDate(indexedAt),
    };
    const tx = this.prisma.tx(market);
    // L2 (package 3a): update only a document read no later than this one; else insert. If a row
    // appeared meanwhile (a concurrent first write), the guarded update runs once more, so that row
    // is replaced only when it was read no later than this one; else this older answer is dropped,
    // children included.
    const guardedUpdate = () =>
      tx.searchOfferDocument.updateMany({
        where: {
          marketId: market.marketId,
          offerId: document.offerId,
          indexedAt: { lte: toDate(indexedAt) },
        },
        data,
      });
    const updated = await guardedUpdate();
    if (updated.count === 0) {
      const created = await tx.searchOfferDocument.createMany({
        data: [
          {
            marketId: market.marketId,
            tenantId: market.tenantId,
            offerId: document.offerId,
            ...data,
          },
        ],
        skipDuplicates: true,
      });
      if (created.count === 0 && (await guardedUpdate()).count === 0) return;
    }
    // The numbers are replaced as a set: the document's own rows go, the current ones come.
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

  async deleteMany(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
    readAt?: Temporal.Instant,
  ): Promise<number> {
    if (offerIds.length === 0) return 0;
    const { count } = await this.prisma.tx(market).searchOfferDocument.deleteMany({
      where: {
        marketId: market.marketId,
        offerId: { in: [...offerIds] },
        ...(readAt === undefined ? {} : { indexedAt: { lte: toDate(readAt) } }),
      },
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
    limit: number,
    after?: Id<'Offer'>,
  ): Promise<readonly Id<'Offer'>[]> {
    const rows = await this.prisma.tx(market).searchOfferDocument.findMany({
      where: {
        marketId: market.marketId,
        categoryIds: { hasSome: [...categoryIds] },
        ...(after === undefined ? {} : { offerId: { gt: after } }),
      },
      select: { offerId: true },
      orderBy: { offerId: 'asc' },
      take: limit,
    });
    return rows.map((row) => row.offerId as Id<'Offer'>);
  }

  async offerIdsWithCultureCode(
    market: MarketContext,
    cultureCode: string,
    limit: number,
    after?: Id<'Offer'>,
  ): Promise<readonly Id<'Offer'>[]> {
    const rows = await this.prisma.tx(market).searchOfferDocument.findMany({
      where: {
        marketId: market.marketId,
        cultureCodes: { has: cultureCode },
        ...(after === undefined ? {} : { offerId: { gt: after } }),
      },
      select: { offerId: true },
      orderBy: { offerId: 'asc' },
      take: limit,
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
