import { Temporal } from '@mondapac/shared-kernel';
import type { AttributeDataType, Id, MarketContext } from '@mondapac/shared-kernel';
import { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  AttributeAdminReader,
  AttributeDefinitionRecord,
  AttributeRevisionRecord,
  CountedField,
  FeatureSetRecord,
} from '../application/ports/attribute-admin.reader';
import type { AttributeBounds, LocalizedText } from '../domain/attribute-definition';
import type { FamilyGroup } from '../domain/attribute-family';
import type { CategoryAuthorKind } from '../domain/platform-category';

const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface RevisionRow {
  readonly id: string;
  readonly revisionNo: number;
  readonly material: boolean;
  readonly isVariantOption: boolean;
  readonly bounds: Prisma.JsonValue;
  readonly names: Prisma.JsonValue;
  readonly helpText: Prisma.JsonValue;
  readonly showOnProductPage: boolean;
  readonly searchable: boolean;
  readonly canBeFilter: boolean;
  readonly internalNote: string | null;
  readonly position: number;
  readonly authorKind: string;
  readonly authorAccountId: string | null;
  readonly createdAt: Date;
  readonly options: readonly {
    readonly optionCode: string;
    readonly labels: Prisma.JsonValue;
    readonly active: boolean;
    readonly position: number;
    readonly mergedInto: string | null;
  }[];
}

const revisionOf = (row: RevisionRow): AttributeRevisionRecord => ({
  id: row.id as Id<'AttributeDefinitionRevision'>,
  revisionNo: row.revisionNo,
  material: row.material,
  isVariantOption: row.isVariantOption,
  bounds: (row.bounds ?? {}) as AttributeBounds,
  names: (row.names ?? {}) as LocalizedText,
  options: row.options.map((option) => ({
    code: option.optionCode,
    labels: (option.labels ?? {}) as LocalizedText,
    active: option.active,
    position: option.position,
    mergedInto: option.mergedInto,
  })),
  display: {
    helpText: (row.helpText ?? {}) as LocalizedText,
    showOnProductPage: row.showOnProductPage,
    searchable: row.searchable,
    canBeFilter: row.canBeFilter,
    internalNote: row.internalNote,
    position: row.position,
  },
  authorKind: row.authorKind as CategoryAuthorKind,
  authorAccountId: row.authorAccountId as Id<'Account'> | null,
  createdAt: toInstant(row.createdAt),
});

const OPTIONS = {
  options: { orderBy: [{ position: 'asc' as const }, { optionCode: 'asc' as const }] },
};

/**
 * A product counts when it is published in the request's Market and its published revision
 * carries a value for the field: a non-null value under the field's code in `attribute_values`,
 * or, for a variant option, on one of the revision's variants (catalog design 3.2: a variant
 * option's values live with the variants).
 */
const holdsField = (field: CountedField): Prisma.CatalogProductRevisionWhereInput =>
  field.isVariantOption
    ? {
        OR: [
          { attributeValues: { path: [field.code], not: Prisma.AnyNull } },
          { variants: { some: { optionValues: { path: [field.code], not: Prisma.AnyNull } } } },
        ],
      }
    : { attributeValues: { path: [field.code], not: Prisma.AnyNull } };

const holdsOption = (
  field: CountedField & { readonly dataType: AttributeDataType },
  optionCode: string,
): Prisma.CatalogProductRevisionWhereInput => {
  const inValues: Prisma.CatalogProductRevisionWhereInput =
    field.dataType === 'multi-select'
      ? { attributeValues: { path: [field.code], array_contains: [optionCode] } }
      : { attributeValues: { path: [field.code], equals: optionCode } };
  return field.isVariantOption
    ? {
        OR: [
          inValues,
          { variants: { some: { optionValues: { path: [field.code], equals: optionCode } } } },
        ],
      }
    : inValues;
};

/**
 * {@link AttributeAdminReader} on `catalog.attribute_definitions`, their revisions and options,
 * `attribute_families` and their revisions, and the published revisions of `catalog.products`.
 * Every statement goes through `PrismaService.tx(market)` with `marketId` at the top level of
 * `where`. Read only; no join outside catalog.
 */
export class PrismaAttributeAdminReader implements AttributeAdminReader {
  constructor(private readonly prisma: PrismaService) {}

  async definitions(
    market: MarketContext,
    limit: number,
  ): Promise<readonly AttributeDefinitionRecord[]> {
    const rows = await this.prisma.tx(market).catalogAttributeDefinition.findMany({
      where: { marketId: market.marketId, publishedRevisionId: { not: null } },
      include: { publishedRevision: { include: OPTIONS } },
      orderBy: [{ code: 'asc' }],
      take: limit,
    });
    return rows.flatMap((row) => (row.publishedRevision === null ? [] : [definitionOf(row)]));
  }

  async definition(
    market: MarketContext,
    id: Id<'AttributeDefinition'>,
  ): Promise<AttributeDefinitionRecord | null> {
    const row = await this.prisma.tx(market).catalogAttributeDefinition.findFirst({
      where: { marketId: market.marketId, id, publishedRevisionId: { not: null } },
      include: { publishedRevision: { include: OPTIONS } },
    });
    return row === null || row.publishedRevision === null ? null : definitionOf(row);
  }

  async revisions(
    market: MarketContext,
    id: Id<'AttributeDefinition'>,
    limit: number,
  ): Promise<readonly AttributeRevisionRecord[]> {
    const rows = await this.prisma.tx(market).catalogAttributeDefinitionRevision.findMany({
      where: { marketId: market.marketId, definitionId: id },
      include: OPTIONS,
      orderBy: [{ revisionNo: 'desc' }],
      take: limit,
    });
    return rows.map(revisionOf);
  }

  async featureSets(market: MarketContext, limit: number): Promise<readonly FeatureSetRecord[]> {
    const rows = await this.prisma.tx(market).catalogAttributeFamily.findMany({
      where: { marketId: market.marketId, publishedRevisionId: { not: null } },
      include: { publishedRevision: true },
      orderBy: [{ code: 'asc' }],
      take: limit,
    });
    return rows.flatMap((row) => (row.publishedRevision === null ? [] : [featureSetOf(row)]));
  }

  async featureSet(
    market: MarketContext,
    id: Id<'AttributeFamily'>,
  ): Promise<FeatureSetRecord | null> {
    const row = await this.prisma.tx(market).catalogAttributeFamily.findFirst({
      where: { marketId: market.marketId, id, publishedRevisionId: { not: null } },
      include: { publishedRevision: true },
    });
    return row === null || row.publishedRevision === null ? null : featureSetOf(row);
  }

  async productCounts(
    market: MarketContext,
    fields: readonly CountedField[],
  ): Promise<ReadonlyMap<string, number>> {
    const tx = this.prisma.tx(market);
    const counts = new Map<string, number>();
    for (const field of fields) {
      counts.set(
        field.code,
        await tx.catalogProduct.count({
          where: {
            marketId: market.marketId,
            status: 'published',
            publishedRevision: { is: holdsField(field) },
          },
        }),
      );
    }
    return counts;
  }

  async optionProductCounts(
    market: MarketContext,
    field: CountedField & { readonly dataType: AttributeDataType },
    optionCodes: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>();
    if (field.dataType !== 'select' && field.dataType !== 'multi-select') return counts;
    const tx = this.prisma.tx(market);
    for (const optionCode of optionCodes) {
      counts.set(
        optionCode,
        await tx.catalogProduct.count({
          where: {
            marketId: market.marketId,
            status: 'published',
            publishedRevision: { is: holdsOption(field, optionCode) },
          },
        }),
      );
    }
    return counts;
  }

  async featureSetProductCounts(
    market: MarketContext,
    ids: readonly Id<'AttributeFamily'>[],
  ): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>(ids.map((id) => [id, 0]));
    if (ids.length === 0) return counts;
    const tx = this.prisma.tx(market);
    // Two queries whatever the number of sets (Hassan, A1 review): the published revisions of
    // published products grouped by family revision, then each family revision's family.
    const groups = await tx.catalogProductRevision.groupBy({
      by: ['familyRevisionId'],
      where: {
        marketId: market.marketId,
        publishedOf: { some: { marketId: market.marketId, status: 'published' } },
        familyRevision: { familyId: { in: [...ids] } },
      },
      _count: { _all: true },
    });
    if (groups.length === 0) return counts;
    const revisions = await tx.catalogAttributeFamilyRevision.findMany({
      where: {
        marketId: market.marketId,
        id: { in: groups.map((group) => group.familyRevisionId) },
      },
      select: { id: true, familyId: true },
    });
    const familyOf = new Map(revisions.map((revision) => [revision.id, revision.familyId]));
    for (const group of groups) {
      const familyId = familyOf.get(group.familyRevisionId);
      if (familyId === undefined) continue;
      counts.set(familyId, (counts.get(familyId) ?? 0) + group._count._all);
    }
    return counts;
  }
}

function definitionOf(row: {
  readonly id: string;
  readonly code: string;
  readonly dataType: string;
  readonly localizable: boolean;
  readonly status: string;
  readonly createdByKind: string;
  readonly createdAt: Date;
  readonly version: number;
  readonly publishedRevision: RevisionRow | null;
}): AttributeDefinitionRecord {
  return {
    id: row.id as Id<'AttributeDefinition'>,
    code: row.code,
    dataType: row.dataType as AttributeDataType,
    localizable: row.localizable,
    status: row.status,
    createdByKind: row.createdByKind as CategoryAuthorKind,
    createdAt: toInstant(row.createdAt),
    version: row.version,
    revision: revisionOf(row.publishedRevision!),
  };
}

function featureSetOf(row: {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  readonly createdByKind: string;
  readonly createdAt: Date;
  readonly version: number;
  readonly publishedRevision: {
    readonly revisionNo: number;
    readonly names: Prisma.JsonValue;
    readonly groups: Prisma.JsonValue;
  } | null;
}): FeatureSetRecord {
  return {
    id: row.id as Id<'AttributeFamily'>,
    code: row.code,
    status: row.status,
    createdByKind: row.createdByKind as CategoryAuthorKind,
    createdAt: toInstant(row.createdAt),
    revisionNo: row.publishedRevision!.revisionNo,
    version: row.version,
    names: (row.publishedRevision!.names ?? {}) as LocalizedText,
    groups: (row.publishedRevision!.groups ?? []) as unknown as FamilyGroup[],
  };
}
