import type { AttributeField, AttributeSchema, Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  CustomVariantLabelRow,
  CustomVariantLabelsPage,
  CustomVariantLabelsReader,
} from '../application/ports/custom-variant-labels.reader';
import { variantCodeOf } from '../domain/product';
import { buildVariantLabels, differingLabels } from '../domain/variant-labels';
import { asTexts } from './locale-pick';

/** Variants read per statement, and statements per call: the scan is bounded. */
export const SCAN_BATCH = 200;
export const MAX_SCAN_BATCHES = 25;

interface GroupsAttribute {
  readonly code: string;
  readonly required: boolean;
  readonly isVariantOption: boolean;
}

function attributesOf(groups: unknown): GroupsAttribute[] {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group: unknown) => {
    const list = (group as { attributes?: unknown } | null)?.attributes;
    return Array.isArray(list) ? (list as GroupsAttribute[]) : [];
  });
}

const stringMap = (value: unknown): Record<string, string> => {
  const map = asTexts(value) ?? {};
  return Object.fromEntries(Object.entries(map).filter(([, v]) => typeof v === 'string'));
};

/**
 * Reads the stored label of each variant of a PUBLISHED revision and the label the builder gives
 * from the revision's pinned family and definition revisions (the labels a re-freeze of that
 * content would write). Catalog tables only; a bounded scan in variant id order.
 */
export class PrismaCustomVariantLabelsReader implements CustomVariantLabelsReader {
  constructor(private readonly prisma: PrismaService) {}

  async page(
    market: MarketContext,
    query: { afterId: string | null; limit: number; locales: readonly string[] },
  ): Promise<CustomVariantLabelsPage> {
    const tx = this.prisma.tx(market);
    const rows: CustomVariantLabelRow[] = [];
    let after = query.afterId;
    for (let batch = 0; batch < MAX_SCAN_BATCHES; batch += 1) {
      const variants = await tx.catalogProductRevisionVariant.findMany({
        where: {
          marketId: market.marketId,
          revision: { is: { publishedOf: { some: {} } } },
          ...(after === null ? {} : { variantId: { gt: after } }),
        },
        orderBy: { variantId: 'asc' },
        take: SCAN_BATCH,
        select: {
          variantId: true,
          productId: true,
          revisionId: true,
          optionValues: true,
          labels: true,
          variant: { select: { variantNo: true, product: { select: { productCode: true } } } },
          revision: {
            select: { familyRevisionId: true, definitionRevisionIds: true },
          },
        },
      });
      if (variants.length === 0) return { rows, nextAfterId: null };

      const familyIds = [...new Set(variants.map((v) => v.revision.familyRevisionId))];
      const definitionIds = [...new Set(variants.flatMap((v) => v.revision.definitionRevisionIds))];
      const [families, definitions, options] = await Promise.all([
        tx.catalogAttributeFamilyRevision.findMany({
          where: { marketId: market.marketId, id: { in: familyIds } },
          select: { id: true, groups: true },
        }),
        tx.catalogAttributeDefinitionRevision.findMany({
          where: { marketId: market.marketId, id: { in: definitionIds } },
          select: { id: true, definition: { select: { code: true, dataType: true } } },
        }),
        tx.catalogAttributeDefinitionRevisionOption.findMany({
          where: { marketId: market.marketId, revisionId: { in: definitionIds } },
          orderBy: { position: 'asc' },
          select: { revisionId: true, optionCode: true, labels: true },
        }),
      ]);
      const groupsOf = new Map(families.map((f) => [f.id, attributesOf(f.groups)]));
      const definitionOf = new Map(definitions.map((d) => [d.id, d.definition]));
      const optionsOf = new Map<string, { code: string; labels: Record<string, string> }[]>();
      for (const option of options) {
        const list = optionsOf.get(option.revisionId) ?? [];
        list.push({ code: option.optionCode, labels: stringMap(option.labels) });
        optionsOf.set(option.revisionId, list);
      }

      for (const variant of variants) {
        const schema = schemaOf(
          groupsOf.get(variant.revision.familyRevisionId) ?? [],
          variant.revision.definitionRevisionIds,
          definitionOf,
          optionsOf,
        );
        const built = buildVariantLabels(schema, stringMap(variant.optionValues), query.locales);
        const differences = differingLabels(stringMap(variant.labels), built, query.locales);
        if (differences.length === 0) continue;
        rows.push({
          productId: variant.productId as Id<'Product'>,
          productCode: variant.variant.product.productCode,
          variantId: variant.variantId as Id<'Variant'>,
          variantNo: variant.variant.variantNo,
          variantCode: variantCodeOf(
            variant.variant.product.productCode,
            variant.variant.variantNo,
          ),
          differences,
        });
        if (rows.length >= query.limit) {
          return { rows, nextAfterId: variant.variantId };
        }
      }
      after = variants[variants.length - 1]!.variantId;
      if (variants.length < SCAN_BATCH) return { rows, nextAfterId: null };
    }
    return { rows, nextAfterId: after };
  }
}

/** The schema fields the label builder reads: the variant axes in family order, with options. */
function schemaOf(
  attributes: readonly GroupsAttribute[],
  definitionRevisionIds: readonly string[],
  definitionOf: ReadonlyMap<string, { code: string; dataType: string }>,
  optionsOf: ReadonlyMap<string, readonly { code: string; labels: Record<string, string> }[]>,
): AttributeSchema {
  const byCode = new Map(
    definitionRevisionIds.flatMap((id) => {
      const definition = definitionOf.get(id);
      return definition === undefined ? [] : [[definition.code, { id, ...definition }] as const];
    }),
  );
  const fields: AttributeField[] = [];
  for (const entry of attributes) {
    const definition = byCode.get(entry.code);
    if (definition === undefined) continue;
    fields.push({
      code: entry.code,
      dataType: definition.dataType as AttributeField['dataType'],
      localizable: false,
      required: entry.required,
      isVariantOption: entry.isVariantOption,
      material: false,
      claimChecked: true,
      bounds: { options: optionsOf.get(definition.id) ?? [] },
    });
  }
  return {
    schemaRef: { familyCode: '', familyRevisionId: '' as Id, definitionRevisionIds: [] },
    fields,
  };
}
