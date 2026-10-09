import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  ListPage,
  OwnCatalogReader,
  ProductLabel,
} from '../application/ports/own-catalog.reader';
import type { Offer } from '../domain/offer';
import type { Product } from '../domain/product';
import type { WorkingCopy } from '../domain/working-copy';
import { offerFromRow } from './prisma-offer.repository';
import { productFromRow } from './prisma-product.repository';

const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** Hard ceiling on a page, whatever the caller asks. */
const MAX_PAGE = 100;

/**
 * {@link OwnCatalogReader} on `catalog.products`, `offers` and `product_working_copies`. Every
 * statement goes through `PrismaService.tx(market)` with `marketId` and the owning seller in
 * `where`; ordering by the UUID v7 id is time order and needs no extra column.
 */
export class PrismaOwnCatalogReader implements OwnCatalogReader {
  constructor(private readonly prisma: PrismaService) {}

  async listProducts(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    page: ListPage<'Product'>,
  ): Promise<readonly Product[]> {
    const rows = await this.prisma.tx(market).catalogProduct.findMany({
      where: {
        marketId: market.marketId,
        scope: 'SELLER',
        ownerSellerId: sellerId,
        status: { notIn: ['discarded', 'withdrawn'] },
        ...(page.afterId === null ? {} : { id: { lt: page.afterId } }),
      },
      include: { variants: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
      orderBy: { id: 'desc' },
      take: Math.min(page.limit, MAX_PAGE),
    });
    return rows.map(productFromRow);
  }

  async listOffers(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    page: ListPage<'Offer'>,
  ): Promise<readonly Offer[]> {
    const rows = await this.prisma.tx(market).catalogOffer.findMany({
      where: {
        marketId: market.marketId,
        sellerId,
        status: { not: 'deleted' },
        ...(page.afterId === null ? {} : { id: { lt: page.afterId } }),
      },
      orderBy: { id: 'desc' },
      take: Math.min(page.limit, MAX_PAGE),
    });
    return rows.map(offerFromRow);
  }

  async productLabels(
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
    locale: string,
  ): Promise<readonly ProductLabel[]> {
    if (productIds.length === 0) return [];
    const tx = this.prisma.tx(market);
    const products = await tx.catalogProduct.findMany({
      where: { marketId: market.marketId, id: { in: [...productIds].slice(0, MAX_PAGE) } },
      select: { id: true, productCode: true, typeCode: true, publishedRevisionId: true },
    });
    const revisionIds = products.flatMap((row) =>
      row.publishedRevisionId === null ? [] : [row.publishedRevisionId],
    );
    const texts =
      revisionIds.length === 0
        ? []
        : await tx.catalogProductRevisionText.findMany({
            where: { marketId: market.marketId, revisionId: { in: revisionIds }, locale },
            select: { revisionId: true, name: true },
          });
    const nameOf = new Map(texts.map((row) => [row.revisionId, row.name]));
    return products.map((row) => ({
      productId: row.id as Id<'Product'>,
      productCode: row.productCode,
      typeCode: row.typeCode,
      name: row.publishedRevisionId === null ? null : (nameOf.get(row.publishedRevisionId) ?? null),
    }));
  }

  async findWorkingCopies(
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
  ): Promise<readonly WorkingCopy[]> {
    if (productIds.length === 0) return [];
    const rows = await this.prisma.tx(market).catalogProductWorkingCopy.findMany({
      where: { marketId: market.marketId, productId: { in: [...productIds].slice(0, MAX_PAGE) } },
    });
    return rows.map((row) => ({
      productId: row.productId as Id<'Product'>,
      content: row.content as Record<string, unknown>,
      contentSchemaVersion: row.contentSchemaVersion,
      baseRevisionId: row.baseRevisionId as Id<'ProductRevision'> | null,
      lastSavedAt: toInstant(row.lastSavedAt),
      lastSavedByAccountId: row.lastSavedByAccountId as Id<'Account'>,
    }));
  }
}
