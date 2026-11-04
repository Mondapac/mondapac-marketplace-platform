import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  MarketTransaction,
  PrismaService,
} from '../../../platform/persistence/prisma.service';
import type { PublishedProductReader } from '../application/ports/published-product.reader';
import type { PublishedProduct } from '../contracts/catalog.facade';
import type { AttributeDataType } from '@mondapac/shared-kernel';
import type { FamilyGroup } from '../domain/attribute-family';
import {
  buildPublishedSpecifications,
  type SpecificationDefinition,
  type SpecificationOption,
} from '../domain/published-specifications';
import { asTexts, pick } from './prisma-offer-listings.reader';

/**
 * {@link PublishedProductReader}: the product by `(market_id, id)` with status `published`, then
 * its published revision's texts, categories and variants, then the variant registry, then the
 * active brand of the product (by id; brands are shared by every Market), then the revision's
 * attribute values with its family revision's groups and the PUBLISHED revisions of the
 * definitions the groups name (names, options and `show_on_product_page` follow the published
 * definition, so an admin's change reaches the page at once). Up to eleven statements, no join,
 * every one scoped by `market_id`; no image or tag is read.
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
    const specifications = await this.specifications(tx, market.marketId, revisionId, locales);
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
      specifications,
    };
  }

  private async specifications(
    tx: MarketTransaction,
    marketId: string,
    revisionId: string,
    locales: { readonly requested: string; readonly fallback: string },
  ) {
    const revision = await tx.catalogProductRevision.findFirst({
      where: { marketId, id: revisionId },
      select: { familyRevisionId: true, attributeValues: true },
    });
    if (revision === null) return [];
    const family = await tx.catalogAttributeFamilyRevision.findFirst({
      where: { marketId, id: revision.familyRevisionId },
      select: { groups: true },
    });
    const values = revision.attributeValues;
    if (family === null || !Array.isArray(family.groups)) return [];
    if (values === null || typeof values !== 'object' || Array.isArray(values)) return [];
    const groups = family.groups as unknown as FamilyGroup[];
    const codes = [...new Set(groups.flatMap((group) => group.attributes.map((a) => a.code)))];
    if (codes.length === 0) return [];
    const definitionRows = await tx.catalogAttributeDefinition.findMany({
      where: { marketId, code: { in: codes } },
      select: {
        code: true,
        dataType: true,
        localizable: true,
        status: true,
        publishedRevisionId: true,
      },
    });
    const revisionIds = definitionRows.flatMap((row) =>
      row.publishedRevisionId === null ? [] : [row.publishedRevisionId],
    );
    if (revisionIds.length === 0) return [];
    const revisions = await tx.catalogAttributeDefinitionRevision.findMany({
      where: { marketId, id: { in: revisionIds } },
      select: { id: true, showOnProductPage: true, names: true },
    });
    const optionRows = await tx.catalogAttributeDefinitionRevisionOption.findMany({
      where: { marketId, revisionId: { in: revisionIds } },
      select: { revisionId: true, optionCode: true, labels: true, mergedInto: true },
    });
    const definitions = new Map<string, SpecificationDefinition>();
    for (const row of definitionRows) {
      const published = revisions.find((candidate) => candidate.id === row.publishedRevisionId);
      if (published === undefined) continue;
      const options = new Map<string, SpecificationOption>();
      for (const option of optionRows) {
        if (option.revisionId !== published.id) continue;
        options.set(option.optionCode, {
          labels: asTexts(option.labels) ?? {},
          mergedInto: option.mergedInto,
        });
      }
      definitions.set(row.code, {
        dataType: row.dataType as AttributeDataType,
        localizable: row.localizable,
        status: row.status as SpecificationDefinition['status'],
        showOnProductPage: published.showOnProductPage,
        names: asTexts(published.names) ?? {},
        options,
      });
    }
    return buildPublishedSpecifications({
      groups,
      values: values,
      definitions,
      locales,
    });
  }
}
