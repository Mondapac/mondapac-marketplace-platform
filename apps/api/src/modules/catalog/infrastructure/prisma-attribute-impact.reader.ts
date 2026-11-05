import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  FEATURE_SET_LIST_MAX,
  IMPACT_COUNT_CAP,
  type AttributeImpact,
  type AttributeImpactReader,
  type CappedCount,
  type ImpactedFeatureSet,
} from '../application/ports/attribute-impact.reader';
import type { LocalizedText } from '../domain/attribute-definition';
import type { FamilyGroup } from '../domain/attribute-family';

const capped = (count: number): CappedCount => ({
  count: Math.min(count, IMPACT_COUNT_CAP),
  atLeast: count >= IMPACT_COUNT_CAP,
});

/** A family list this long is not read whole; the Market's feature sets are tens. */
const FAMILY_READ_MAX = 1_000;

/**
 * {@link AttributeImpactReader} on the published revisions of products, working copies, feature
 * sets and category links of one Market (attributes A8). Every statement goes through
 * `PrismaService.tx(market)` with `marketId` at the top level of `where`; every count is bounded
 * by `take` so a large Market answers "at least N" instead of scanning to the end.
 */
export class PrismaAttributeImpactReader implements AttributeImpactReader {
  constructor(private readonly prisma: PrismaService) {}

  async impactOf(
    market: MarketContext,
    attribute: { readonly code: string; readonly isVariantOption: boolean },
  ): Promise<AttributeImpact> {
    const tx = this.prisma.tx(market);
    const { code } = attribute;
    const base = { marketId: market.marketId };
    const holdsInValues: Prisma.CatalogProductRevisionWhereInput = {
      attributeValues: { path: [code], not: Prisma.AnyNull },
    };
    const holdsField: Prisma.CatalogProductRevisionWhereInput = attribute.isVariantOption
      ? {
          OR: [
            holdsInValues,
            { variants: { some: { optionValues: { path: [code], not: Prisma.AnyNull } } } },
          ],
        }
      : holdsInValues;

    const published = await tx.catalogProduct.count({
      where: { ...base, status: 'published', publishedRevision: { is: holdsField } },
      take: IMPACT_COUNT_CAP,
    });
    const drafts = await tx.catalogProductWorkingCopy.count({
      where: { ...base, content: { path: ['attributeValues', code], not: Prisma.AnyNull } },
      take: IMPACT_COUNT_CAP,
    });
    const liveVariantProducts = attribute.isVariantOption
      ? await tx.catalogProduct.count({
          where: {
            ...base,
            status: 'published',
            publishedRevision: {
              is: {
                variants: { some: { optionValues: { path: [code], not: Prisma.AnyNull } } },
              },
            },
          },
          take: IMPACT_COUNT_CAP,
        })
      : 0;

    const families = await tx.catalogAttributeFamily.findMany({
      where: { ...base, status: 'active', publishedRevisionId: { not: null } },
      include: { publishedRevision: true },
      orderBy: [{ code: 'asc' }],
      take: FAMILY_READ_MAX,
    });
    const using: ImpactedFeatureSet[] = [];
    for (const family of families) {
      const groups = (family.publishedRevision?.groups ?? []) as unknown as FamilyGroup[];
      if (groups.some((group) => group.attributes.some((entry) => entry.code === code))) {
        using.push({
          id: family.id as Id<'AttributeFamily'>,
          code: family.code,
          names: (family.publishedRevision?.names ?? {}) as LocalizedText,
        });
      }
    }
    const categories =
      using.length === 0
        ? 0
        : await tx.catalogCategoryAttributeLink.count({
            where: {
              ...base,
              publishedRevision: { is: { familyId: { in: using.map((family) => family.id) } } },
            },
            take: IMPACT_COUNT_CAP,
          });
    const filters = await tx.catalogCategoryAttributeLink.count({
      where: {
        ...base,
        publishedRevision: { is: { filters: { array_contains: [code] } } },
      },
      take: IMPACT_COUNT_CAP,
    });

    return {
      publishedProducts: capped(published),
      drafts: capped(drafts),
      featureSetCount: using.length,
      featureSets: using.slice(0, FEATURE_SET_LIST_MAX),
      categories: capped(categories),
      filters: capped(filters),
      liveVariantProducts: capped(liveVariantProducts),
    };
  }
}
