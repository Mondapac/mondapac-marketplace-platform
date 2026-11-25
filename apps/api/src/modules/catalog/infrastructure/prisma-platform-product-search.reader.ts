import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { escapeLikeTerm } from '../../../platform/text/like-escape';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  PlatformProductGtinMatch,
  PlatformProductSearchPage,
  PlatformProductSearchQuery,
  PlatformProductSearchReader,
  PlatformProductSearchRow,
} from '../application/ports/platform-product-search.reader';

const MAX_LOOKUP = 200;

/** Products a seller may be offered: PLATFORM, published and not paused. */
const sellableBase = (market: MarketContext): Prisma.CatalogProductWhereInput => ({
  marketId: market.marketId,
  scope: 'PLATFORM',
  status: 'published',
  pausedAt: null,
  publishedRevisionId: { not: null },
});

/**
 * {@link PlatformProductSearchReader} on `catalog.products` and its published revision. Every
 * statement carries `market_id`; no join across modules.
 */
export class PrismaPlatformProductSearchReader implements PlatformProductSearchReader {
  constructor(private readonly prisma: PrismaService) {}

  async search(
    market: MarketContext,
    query: PlatformProductSearchQuery,
  ): Promise<PlatformProductSearchPage> {
    if (query.allowedCategoryIds.size === 0) return { rows: [], total: 0 };
    const tx = this.prisma.tx(market);
    const allowed = [...query.allowedCategoryIds];
    const { sellerId } = query;
    const inScope: Prisma.CatalogProductWhereInput = {
      publishedRevision: { is: { categories: { some: { categoryId: { in: allowed } } } } },
    };
    const clauses: Prisma.CatalogProductWhereInput[] = [];
    if (query.text !== null) {
      const text = escapeLikeTerm(query.text);
      clauses.push(
        { productCode: { contains: text, mode: 'insensitive' } },
        {
          publishedRevision: {
            is: {
              texts: {
                some: { locale: query.locale, name: { contains: text, mode: 'insensitive' } },
              },
            },
          },
        },
      );
      // A brand found by its name, and a category found by its name inside the scope.
      const brands = await tx.catalogBrand.findMany({
        where: { name: { contains: text, mode: 'insensitive' }, status: 'active' },
        select: { id: true },
        take: 200,
      });
      if (brands.length > 0) clauses.push({ brandId: { in: brands.map((brand) => brand.id) } });
      const categories = await tx.catalogPlatformCategory.findMany({
        where: {
          marketId: market.marketId,
          id: { in: allowed },
          publishedRevision: {
            is: {
              names: {
                some: { locale: query.locale, name: { contains: text, mode: 'insensitive' } },
              },
            },
          },
        },
        select: { id: true },
        take: 200,
      });
      if (categories.length > 0) {
        clauses.push({
          publishedRevision: {
            is: { categories: { some: { categoryId: { in: categories.map((row) => row.id) } } } },
          },
        });
      }
      if (query.gtins.length > 0) {
        clauses.push({
          publishedRevision: { is: { variants: { some: { gtin: { in: [...query.gtins] } } } } },
        });
      }
    }
    // "Already selling" is the same test as `alreadySelling` below: a not-deleted Offer of the seller.
    const notSelling: Prisma.CatalogProductWhereInput[] = query.notSelling
      ? [
          {
            offers: {
              none: { marketId: market.marketId, sellerId, status: { not: 'deleted' } },
            },
          },
        ]
      : [];
    const where: Prisma.CatalogProductWhereInput = {
      // The Market guard wants `marketId` at the top of the filter, not only inside an AND.
      marketId: market.marketId,
      AND: [
        sellableBase(market),
        inScope,
        ...notSelling,
        ...(clauses.length > 0 ? [{ OR: clauses }] : []),
      ],
    };
    const [total, found] = await Promise.all([
      tx.catalogProduct.count({ where }),
      tx.catalogProduct.findMany({
        where,
        select: { id: true },
        orderBy: { id: 'desc' },
        skip: query.offset,
        take: query.limit,
      }),
    ]);
    const rows = await this.rowsOf(
      market,
      query.sellerId,
      found.map((row) => row.id),
      query.locale,
    );
    return { rows, total };
  }

  async lookupGtins(
    market: MarketContext,
    query: {
      readonly sellerId: Id<'Seller'>;
      readonly allowedCategoryIds: ReadonlySet<Id<'Category'>>;
      readonly locale: string;
      readonly gtins: readonly string[];
    },
  ): Promise<readonly PlatformProductGtinMatch[]> {
    const wanted = [...new Set(query.gtins)].slice(0, MAX_LOOKUP);
    if (wanted.length === 0) return [];
    const tx = this.prisma.tx(market);
    const variants = await tx.catalogProductRevisionVariant.findMany({
      where: {
        marketId: market.marketId,
        gtin: { in: wanted },
        revision: { is: { publishedOf: { some: { ...sellableBase(market) } } } },
      },
      select: { productId: true, gtin: true },
      take: MAX_LOOKUP * 2,
    });
    const productIds = [...new Set(variants.map((row) => row.productId))];
    const rows = await this.rowsOf(market, query.sellerId, productIds, query.locale);
    const rowById = new Map(rows.map((row) => [row.productId as string, row]));
    // Scope per product: any category of the published revision inside the seller's set.
    const scoped =
      productIds.length === 0 || query.allowedCategoryIds.size === 0
        ? []
        : await tx.catalogProductRevisionCategory.findMany({
            where: {
              marketId: market.marketId,
              categoryId: { in: [...query.allowedCategoryIds] },
              revision: { is: { publishedOf: { some: { id: { in: productIds } } } } },
            },
            select: { revision: { select: { productId: true } } },
          });
    const inScope = new Set(scoped.map((row) => row.revision.productId));
    const matches: PlatformProductGtinMatch[] = [];
    for (const variant of variants) {
      const row = rowById.get(variant.productId);
      if (row === undefined || variant.gtin === null) continue;
      matches.push({ gtin: variant.gtin, row, inScope: inScope.has(variant.productId) });
    }
    return matches;
  }

  private async rowsOf(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    productIds: readonly string[],
    locale: string,
  ): Promise<readonly PlatformProductSearchRow[]> {
    if (productIds.length === 0) return [];
    const tx = this.prisma.tx(market);
    const products = await tx.catalogProduct.findMany({
      where: { marketId: market.marketId, id: { in: [...productIds] } },
      select: {
        id: true,
        productCode: true,
        brandId: true,
        publishedRevision: {
          select: {
            texts: { where: { locale }, select: { name: true } },
            categories: {
              orderBy: { position: 'asc' },
              select: { categoryId: true, isPrimary: true },
            },
            variants: { select: { variantId: true } },
          },
        },
      },
    });
    const brandIds = [...new Set(products.flatMap((row) => row.brandId ?? []))];
    const brands =
      brandIds.length === 0
        ? []
        : await tx.catalogBrand.findMany({
            where: { id: { in: brandIds } },
            select: { id: true, name: true },
          });
    const brandName = new Map(brands.map((brand) => [brand.id, brand.name]));
    const primaryOf = (row: (typeof products)[number]): string | null => {
      const categories = row.publishedRevision?.categories ?? [];
      return (categories.find((c) => c.isPrimary) ?? categories[0])?.categoryId ?? null;
    };
    const categoryIds = [...new Set(products.flatMap((row) => primaryOf(row) ?? []))];
    const categories =
      categoryIds.length === 0
        ? []
        : await tx.catalogPlatformCategory.findMany({
            where: { marketId: market.marketId, id: { in: categoryIds } },
            select: {
              id: true,
              publishedRevision: {
                select: { names: { where: { locale }, select: { name: true } } },
              },
            },
          });
    const categoryName = new Map(
      categories.map((row) => [row.id, row.publishedRevision?.names[0]?.name ?? null]),
    );
    const selling = await tx.catalogOffer.groupBy({
      by: ['productId'],
      where: {
        marketId: market.marketId,
        sellerId,
        productId: { in: [...productIds] },
        status: { not: 'deleted' },
      },
      _count: { _all: true },
    });
    const sellingSet = new Set(selling.map((row) => row.productId));
    const byId = new Map(products.map((row) => [row.id, row]));
    return productIds.flatMap((id): PlatformProductSearchRow[] => {
      const row = byId.get(id);
      if (row === undefined) return [];
      const categoryId = primaryOf(row);
      return [
        {
          productId: row.id as Id<'Product'>,
          productCode: row.productCode,
          name: row.publishedRevision?.texts[0]?.name ?? null,
          brandName: row.brandId === null ? null : (brandName.get(row.brandId) ?? null),
          categoryId: categoryId as Id<'Category'> | null,
          categoryName: categoryId === null ? null : (categoryName.get(categoryId) ?? null),
          variantCount: row.publishedRevision?.variants.length ?? 0,
          alreadySelling: sellingSet.has(row.id),
        },
      ];
    });
  }
}
