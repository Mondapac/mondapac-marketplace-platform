import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  CategoryTreeUnavailableError,
  MAX_TREE_NODES,
  liveCategoryTree,
  type LiveCategory,
} from '../../domain/category-tree';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { CategoryTreeReader } from '../ports/category-tree.reader';
import type { ClaimEvaluator } from '../ports/claim-evaluator';
import { invalid, type ValidationFailure } from './culture-views';

type Unavailable = { readonly code: 'access.unavailable' };

/**
 * Checks that a required certification type is an existing, active type of the Market. Asked of
 * certification through the claim-evaluator port (its facade), never by a join. Runs outside any
 * unit of work (the facade opens its own); a failed read is `access.unavailable` (fail closed).
 */
export async function checkRequiredCertificationType(
  evaluator: ClaimEvaluator,
  context: CallContext,
  typeCode: string,
): Promise<Result<void, ValidationFailure | Unavailable>> {
  const active = await evaluator.activeTypeCodes(context);
  if (!active.ok) return err({ code: 'access.unavailable' });
  return active.value.has(typeCode)
    ? ok(undefined)
    : invalid('requiredCertificationType', 'unknown');
}

/**
 * The live tree of the Market (active categories only). A tree that cannot be built is
 * `access.unavailable`. Runs inside the caller's unit.
 */
export async function liveTreeOf(
  market: MarketContext,
  deps: { readonly treeReader: CategoryTreeReader; readonly policy: CatalogMarketPolicy },
): Promise<Result<readonly LiveCategory[], Unavailable>> {
  const nodes = await deps.treeReader.nodes(market, MAX_TREE_NODES + 1);
  try {
    return ok(liveCategoryTree(nodes, deps.policy.locales(market).default));
  } catch (error) {
    if (error instanceof CategoryTreeUnavailableError) return err({ code: 'access.unavailable' });
    throw error;
  }
}
