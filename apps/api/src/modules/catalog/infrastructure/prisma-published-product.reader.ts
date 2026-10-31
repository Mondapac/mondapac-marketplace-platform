import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { PublishedProductReader } from '../application/ports/published-product.reader';
import type { PublishedProduct } from '../contracts/catalog.facade';
import { asTexts, pick } from './prisma-offer-listings.reader';

/**
 * {@link PublishedProductReader}: the product by `(market_id, id)` with status `published`, then
 * its published revision's texts, categories and variants, then the variant registry, then the
 * active brand of the product (by id; brands are shared by every Market). Up to six
 * statements, no join, every one scoped by `market_id`; no image, attribute or tag is read.
 */
export class PrismaPublishedProductReader implements PublishedProductReader {
  constructor(private readonly prisma: PrismaService) {}

  async read(
    market: MarketContext,
    productId: Id<'Product'>,
    locales: { readonly requested: string; readonly fallback: string },
  ): Promise<PublishedProduct | null> {
    const tx = this.prisma.tx(market);
    const product = await tx.catalogProduct.findFirst({
      // A paused product is not shown (catalog design 4.1a).
      where: { marketId: market.marketId, id: productId, status: 'published', pausedAt: null },
      select: { publishedRevisionId: true, brandId: true },
    });
    if (product === null || product.publishedRevisionId === null) return null;
    const revisionId = product.publishedRevisionId;

    const texts = await tx.catalogProductRevisionText.findMany({
      where: { marketId: market.marketId, revisionId },
      select: { locale: true, name: true, shortDescription: true, description: true },
    });
    // The locale is picked once, by the name, so the texts of one product never mix locales.
    const picked = pick(
      Object.fromEntries(texts.map((text) => [text.locale, text.locale])),
      locales,
    );
    const text = texts.find((row) => row.locale === picked);
    if (text === undefined) return null;
    const categories = await tx.catalogProductRevisionCategory.findMany({
      where: { marketId: market.marketId, revisionId },
      orderBy: [{ position: 'asc' }],
      select: { categoryId: true },
    });
    const revisionVariants = await tx.catalogProductRevisionVariant.findMany({
      where: { marketId: market.marketId, revisionId },
      orderBy: [{ position: 'asc' }],
      select: { variantId: true, position: true, labels: true },
    });
    const published = new Set(
      revisionVariants.length === 0
        ? []
        : (
            await tx.catalogProductVariant.findMany({
              where: {
                marketId: market.marketId,
                productId,
                id: { in: revisionVariants.map((row) => row.variantId) },
                state: 'published',
              },
              select: { id: true },
            })
          ).map((row) => row.id),
    );
    // The brand is shown only while it is active; a draft or archived one is no brand here.
    const brand =
      product.brandId === null
        ? null
        : await tx.catalogBrand.findFirst({
            where: { id: product.brandId, status: 'active' },
            select: { slug: true, name: true },
          });
    return {
      productId,
      publishedRevisionId: revisionId as Id<'ProductRevision'>,
      name: text.name,
      shortDescription: text.shortDescription,
      description: text.description,
      categoryIds: categories.map((row) => row.categoryId as Id<'Category'>),
      variants: revisionVariants
        .filter((row) => published.has(row.variantId))
        .map((row) => {
          const labels = asTexts(row.labels);
          return {
            variantId: row.variantId as Id<'Variant'>,
            position: row.position,
            label: labels === null ? null : pick(labels, locales),
          };
        }),
      brand,
    };
  }
}
