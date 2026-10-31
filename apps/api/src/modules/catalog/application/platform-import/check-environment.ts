import { ok } from '@mondapac/shared-kernel';
import type { MarketContext, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  CategoryTreeUnavailableError,
  liveCategoryTree,
  MAX_TREE_NODES,
} from '../../domain/category-tree';
import { looseName, type CheckEnvironment } from '../../domain/platform-import/row-check';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { CategoryTreeReader } from '../ports/category-tree.reader';
import type { ProductTypeLookup } from '../ports/product-type-lookup';

export interface CheckEnvironmentDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly treeReader: CategoryTreeReader;
  readonly attributes: AttributeRepository;
  readonly policy: CatalogMarketPolicy;
  readonly productTypes: ProductTypeLookup;
}

/** The facts for a check or a run could not be read; nothing was checked. */
export type CheckEnvironmentFailure = { readonly code: 'access.unavailable' };

/**
 * Reads what a row is checked against (design 14a): the Market's live categories, its offered
 * product types, the default family's attribute schema, the tax categories and locales. One
 * read-only unit (ADR-0025); a configuration fault, a category tree that cannot be built or a
 * family that is missing is `access.unavailable`, never a partial check.
 */
export async function readCheckEnvironment(
  deps: CheckEnvironmentDependencies,
  market: MarketContext,
): Promise<Result<CheckEnvironment, CheckEnvironmentFailure>> {
  let locales: { readonly default: string; readonly supported: readonly string[] };
  let familyCode: string;
  let typesOffered: readonly string[];
  let taxCategoryCodes: readonly string[];
  try {
    locales = deps.policy.locales(market);
    familyCode = deps.policy.defaultFamily(market);
    typesOffered = deps.policy.productTypes(market);
    taxCategoryCodes = deps.policy.taxCategoryCodes(market);
  } catch {
    return { ok: false, error: { code: 'access.unavailable' } };
  }
  const read = await deps.unitOfWork.run(
    market,
    async () =>
      ok({
        nodes: await deps.treeReader.nodes(market, MAX_TREE_NODES + 1),
        schema: await deps.attributes.loadSchema(market, familyCode),
      }),
    { readOnly: true },
  );
  if (!read.ok || read.value.schema === null) {
    return { ok: false, error: { code: 'access.unavailable' } };
  }
  let live;
  try {
    live = liveCategoryTree(read.value.nodes, locales.default);
  } catch (error) {
    if (error instanceof CategoryTreeUnavailableError) {
      return { ok: false, error: { code: 'access.unavailable' } };
    }
    throw error;
  }
  const byName = new Map<string, string[]>();
  const bySlug = new Map<string, string>();
  for (const category of live) {
    const key = looseName(category.name);
    byName.set(key, [...(byName.get(key) ?? []), category.id]);
    bySlug.set(category.slug.toLowerCase(), category.id);
  }
  return ok({
    defaultLocale: locales.default,
    locales: [locales.default, ...locales.supported.filter((locale) => locale !== locales.default)],
    categoriesByName: byName,
    categoriesBySlug: bySlug,
    typesOffered,
    handlerFor: deps.productTypes,
    schema: read.value.schema,
    taxCategoryCodes,
  });
}
