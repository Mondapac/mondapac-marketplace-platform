import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { PublishedProductReader } from '../application/ports/published-product.reader';
import type { PublishedProduct } from '../contracts/catalog.facade';
import {
  publishedSpecificationsOf,
  type SpecificationDefinition,
  type SpecificationFamilyGroup,
} from '../application/published-specifications';
import { asTexts, pick } from './prisma-offer-listings.reader';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * {@link PublishedProductReader}: the product by `(market_id, id)` with status `published`, then
 * its published revision's texts, categories and variants, then the variant registry, then the
 * active brand of the product (by id; brands are shared by every Market), then the specifications
 * (the revision's attribute values with the family revision and the definition revisions it was
 * validated against, so names and labels are those of that time). Up to eleven statements, no
 * join, every one scoped by `market_id`; no image or tag is read.
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
    const specifications = await this.specifications(tx, market, revisionId, locales);
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
    tx: ReturnType<PrismaService['tx']>,
    market: MarketContext,
    revisionId: string,
    locales: { readonly requested: string; readonly fallback: string },
  ): Promise<PublishedProduct['specifications']> {
    const revision = await tx.catalogProductRevision.findFirst({
      where: { marketId: market.marketId, id: revisionId },
      select: { attributeValues: true, familyRevisionId: true, definitionRevisionIds: true },
    });
    if (revision === null || !isRecord(revision.attributeValues)) return [];
    const values = revision.attributeValues;
    if (Object.keys(values).length === 0) return [];
    const family = await tx.catalogAttributeFamilyRevision.findFirst({
      where: { marketId: market.marketId, id: revision.familyRevisionId },
      select: { groups: true },
    });
    if (family === null || !Array.isArray(family.groups)) return [];
    const groups = (family.groups as unknown[]).flatMap((group): SpecificationFamilyGroup[] => {
      if (!isRecord(group) || typeof group.groupCode !== 'string') return [];
      const attributes = Array.isArray(group.attributes) ? (group.attributes as unknown[]) : [];
      return [
        {
          groupCode: group.groupCode,
          attributes: attributes.flatMap((attribute) =>
            isRecord(attribute) && typeof attribute.code === 'string'
              ? [{ code: attribute.code }]
              : [],
          ),
        },
      ];
    });
    const revisions = await tx.catalogAttributeDefinitionRevision.findMany({
      where: { marketId: market.marketId, id: { in: [...revision.definitionRevisionIds] } },
      select: { id: true, definitionId: true, names: true },
    });
    if (revisions.length === 0) return [];
    const roots = await tx.catalogAttributeDefinition.findMany({
      where: { marketId: market.marketId, id: { in: revisions.map((row) => row.definitionId) } },
      select: { id: true, code: true, dataType: true, localizable: true },
    });
    const options = await tx.catalogAttributeDefinitionRevisionOption.findMany({
      where: { marketId: market.marketId, revisionId: { in: revisions.map((row) => row.id) } },
      select: { revisionId: true, optionCode: true, labels: true },
    });
    const rootOf = new Map(roots.map((root) => [root.id, root]));
    const definitions = new Map<string, SpecificationDefinition>();
    for (const row of revisions) {
      const root = rootOf.get(row.definitionId);
      const names = asTexts(row.names);
      if (root === undefined || names === null) continue;
      definitions.set(root.code, {
        code: root.code,
        dataType: root.dataType,
        localizable: root.localizable,
        names,
        options: new Map(
          options
            .filter((option) => option.revisionId === row.id)
            .flatMap((option) => {
              const labels = asTexts(option.labels);
              return labels === null ? [] : [[option.optionCode, labels] as const];
            }),
        ),
      });
    }
    return publishedSpecificationsOf(groups, definitions, values, locales);
  }
}
