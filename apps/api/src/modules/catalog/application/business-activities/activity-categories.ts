import { err, ok } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { ACTIVITY_CATEGORY_MAX_DEPTH } from '../../domain/business-activity';
import {
  CategoryTreeUnavailableError,
  MAX_TREE_NODES,
  liveCategoryTree,
} from '../../domain/category-tree';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { CategoryTreeReader } from '../ports/category-tree.reader';
import type { ValidationFailure } from './business-activity-views';

/**
 * Checks that every linked category is a live (active) category of the Market on level 1 or 2 of
 * the tree. Runs inside the caller's unit. A tree that cannot be built is `access.unavailable`
 * (fail closed); a category that is unknown, archived, merged or deeper is a validation problem on
 * its index.
 */
export async function checkLinkedCategories(
  market: MarketContext,
  categoryIds: readonly Id<'Category'>[],
  deps: { readonly treeReader: CategoryTreeReader; readonly policy: CatalogMarketPolicy },
): Promise<Result<void, ValidationFailure | { readonly code: 'access.unavailable' }>> {
  if (categoryIds.length === 0) return ok(undefined);
  const nodes = await deps.treeReader.nodes(market, MAX_TREE_NODES + 1);
  let depthOf: Map<string, number>;
  try {
    const live = liveCategoryTree(nodes, deps.policy.locales(market).default);
    depthOf = new Map(live.map((category) => [category.id as string, category.depth]));
  } catch (error) {
    if (error instanceof CategoryTreeUnavailableError) return err({ code: 'access.unavailable' });
    throw error;
  }
  const fields: { path: string; code: string }[] = [];
  categoryIds.forEach((id, index) => {
    const depth = depthOf.get(id);
    if (depth === undefined) fields.push({ path: `categoryIds.${index}`, code: 'unknown' });
    else if (depth > ACTIVITY_CATEGORY_MAX_DEPTH) {
      fields.push({ path: `categoryIds.${index}`, code: 'too-deep' });
    }
  });
  return fields.length === 0 ? ok(undefined) : err({ code: 'validation.failed', fields });
}
