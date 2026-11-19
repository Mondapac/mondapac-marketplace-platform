import type { MarketTransaction } from '../../../platform/persistence/prisma.service';
import type { VariantAxisValue } from '../contracts/catalog.facade';
import { asTexts, pick } from './locale-pick';

const isStringMap = (value: unknown): value is Record<string, string> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The axis values of variants for the facades (variants V2): for each stored `optionValues`
 * (`attributeCode: optionCode`), the attribute, the option and the option's label in the asked
 * locale (fallback as everywhere: the Market's default, then any). Labels follow the PUBLISHED
 * definition revisions, the way the specification rows do. Two statements however many variants;
 * an option with no label gives the option code as its label, never a made-up text.
 * Axes come in attribute-code order so the answer is stable.
 */
export async function readAxisValues(
  tx: MarketTransaction,
  marketId: string,
  optionValues: readonly unknown[],
  locales: { readonly requested: string; readonly fallback: string },
): Promise<VariantAxisValue[][]> {
  const maps = optionValues.map((raw) => (isStringMap(raw) ? raw : {}));
  const codes = [...new Set(maps.flatMap((map) => Object.keys(map)))];
  if (codes.length === 0) return maps.map(() => []);
  const definitions = await tx.catalogAttributeDefinition.findMany({
    where: { marketId, code: { in: codes } },
    select: { code: true, publishedRevisionId: true },
  });
  const revisionOf = new Map(
    definitions.flatMap((row) =>
      row.publishedRevisionId === null ? [] : [[row.code, row.publishedRevisionId] as const],
    ),
  );
  const options =
    revisionOf.size === 0
      ? []
      : await tx.catalogAttributeDefinitionRevisionOption.findMany({
          where: { marketId, revisionId: { in: [...revisionOf.values()] } },
          select: { revisionId: true, optionCode: true, labels: true },
        });
  const labelOf = new Map(
    options.map((row) => [`${row.revisionId}:${row.optionCode}`, asTexts(row.labels) ?? {}]),
  );
  return maps.map((map) =>
    Object.keys(map)
      .sort()
      .map((attributeCode) => {
        const optionCode = map[attributeCode]!;
        const revisionId = revisionOf.get(attributeCode);
        const labels =
          revisionId === undefined ? undefined : labelOf.get(`${revisionId}:${optionCode}`);
        return {
          attributeCode,
          optionCode,
          label: (labels === undefined ? null : pick(labels, locales)) ?? optionCode,
        };
      }),
  );
}
