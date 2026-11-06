import type { AttributeDataType } from '@mondapac/shared-kernel';
import type { MarketTransaction } from '../../../platform/persistence/prisma.service';
import type {
  LoadedSearchDefinition,
  SearchDefinition,
  SearchOption,
} from '../domain/search-attributes';
import { asTexts } from './prisma-offer-listings.reader';

const MAX_CODES = 500;

/**
 * The definitions with these codes in the Market, each with its published revision's flags,
 * names and options (insert-only revisions: a change by an admin reaches search at the next read).
 * A definition with no published revision is absent. Three statements, no join, all by `market_id`.
 */
export async function loadSearchDefinitions(
  tx: MarketTransaction,
  marketId: string,
  codes: readonly string[],
): Promise<ReadonlyMap<string, LoadedSearchDefinition>> {
  const result = new Map<string, LoadedSearchDefinition>();
  const unique = [...new Set(codes)].slice(0, MAX_CODES);
  if (unique.length === 0) return result;
  const definitions = await tx.catalogAttributeDefinition.findMany({
    where: { marketId, code: { in: unique } },
    select: {
      code: true,
      dataType: true,
      localizable: true,
      status: true,
      publishedRevisionId: true,
      id: true,
      mergedIntoId: true,
    },
  });
  // A merged attribute is indexed as its target (attributes A8), which the product need not carry.
  const have = new Set(definitions.map((row) => row.id));
  const targetIds = [
    ...new Set(
      definitions.flatMap((row) =>
        row.mergedIntoId === null || have.has(row.mergedIntoId) ? [] : [row.mergedIntoId],
      ),
    ),
  ];
  const targets =
    targetIds.length === 0
      ? []
      : await tx.catalogAttributeDefinition.findMany({
          where: { marketId, id: { in: targetIds } },
          select: {
            code: true,
            dataType: true,
            localizable: true,
            status: true,
            publishedRevisionId: true,
            id: true,
            mergedIntoId: true,
          },
        });
  const allRows = [...definitions, ...targets];
  const mergeRows = await tx.catalogAttributeMergeOption.findMany({
    where: {
      marketId,
      sourceId: { in: definitions.flatMap((row) => (row.mergedIntoId === null ? [] : [row.id])) },
    },
    select: { sourceId: true, sourceCode: true, targetCode: true },
  });
  const codeOfId = new Map(allRows.map((row) => [row.id, row.code] as const));
  const revisionIds = allRows.flatMap((row) =>
    row.publishedRevisionId === null ? [] : [row.publishedRevisionId],
  );
  if (revisionIds.length === 0) return result;
  const revisions = await tx.catalogAttributeDefinitionRevision.findMany({
    where: { marketId, id: { in: revisionIds } },
    select: { id: true, searchable: true, canBeFilter: true, names: true },
  });
  const optionRows = await tx.catalogAttributeDefinitionRevisionOption.findMany({
    where: { marketId, revisionId: { in: revisionIds } },
    select: {
      revisionId: true,
      optionCode: true,
      labels: true,
      mergedInto: true,
      active: true,
      position: true,
    },
    orderBy: [{ revisionId: 'asc' }, { position: 'asc' }],
  });
  const revisionById = new Map(revisions.map((row) => [row.id, row]));
  for (const row of allRows) {
    const revision =
      row.publishedRevisionId === null ? undefined : revisionById.get(row.publishedRevisionId);
    if (revision === undefined) continue;
    const options = new Map<string, SearchOption>();
    const optionOrder: string[] = [];
    for (const option of optionRows) {
      if (option.revisionId !== revision.id) continue;
      options.set(option.optionCode, {
        labels: asTexts(option.labels) ?? {},
        mergedInto: option.mergedInto,
        active: option.active,
      });
      optionOrder.push(option.optionCode);
    }
    result.set(row.code, {
      code: row.code,
      dataType: row.dataType as AttributeDataType,
      localizable: row.localizable,
      status: row.status as SearchDefinition['status'],
      searchable: revision.searchable,
      canBeFilter: revision.canBeFilter,
      names: asTexts(revision.names) ?? {},
      options,
      optionOrder,
      mergedInto:
        row.mergedIntoId === null || codeOfId.get(row.mergedIntoId) === undefined
          ? null
          : {
              code: codeOfId.get(row.mergedIntoId)!,
              options: new Map(
                mergeRows
                  .filter((merge) => merge.sourceId === row.id)
                  .map((merge) => [merge.sourceCode, merge.targetCode] as const),
              ),
            },
    });
  }
  return result;
}
