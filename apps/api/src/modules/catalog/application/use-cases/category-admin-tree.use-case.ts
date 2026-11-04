import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { adminCategoryTree } from '../../domain/category-admin-tree';
import { CategoryTreeUnavailableError, MAX_TREE_NODES } from '../../domain/category-tree';
import { CATALOG_CATEGORY_TREE_VIEW } from '../../contracts/permissions';
import {
  CATEGORY_COUNT_BUDGET_MS,
  categoryActions,
  closedInput,
  requiredCategoryLocales,
  rowViewOf,
  type ActionMap,
  type CategoryActionProbes,
  type CategoryRowView,
  type ValidationFailure,
} from '../categories/category-admin-views';
import type { AdminCategoryReader } from '../ports/admin-category.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';

export interface CategoryAdminTreeOutput {
  /** `category_trees.version`: what a structural change must name (C3 on). */
  readonly treeVersion: number;
  readonly defaultLocale: string;
  readonly supportedLocales: readonly string[];
  /** The locales every category needs a name in. */
  readonly requiredLocales: readonly string[];
  /** False when the counts hit their time bound: they are then "at least". */
  readonly complete: boolean;
  /** Depth first, siblings in order. */
  readonly categories: readonly CategoryRowView[];
  readonly actions: ActionMap;
}

export type CategoryAdminTreeFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'catalog.categories-unavailable' }
  | ValidationFailure;

export interface CategoryAdminTreeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly adminCategoryReader: AdminCategoryReader;
  readonly policy: CatalogMarketPolicy;
  readonly categoryProbes: CategoryActionProbes;
}

/**
 * `category-tree.admin-list` (categories package C1): the whole platform category tree of the
 * Market for the admin page, in any status, with names per locale, depth, place among siblings and
 * the counts of live products and Offers. One read-only unit; the counts are bounded at 10 seconds
 * and then `complete` is false. A tree that cannot be built is `catalog.categories-unavailable`,
 * never a partial tree. Rule: the key `catalog.category-tree.view` and the admin population.
 */
export class CategoryAdminTree extends UseCase<
  Record<string, never>,
  CategoryAdminTreeOutput,
  CategoryAdminTreeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-admin-tree',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_VIEW.key] },
  };

  readonly #logger = new Logger('CategoryAdminTree');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryAdminTreeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Record<string, never>,
  ): Promise<Result<CategoryAdminTreeOutput, CategoryAdminTreeFailure>> {
    const result = await this.#read(context, input);
    this.#logger.log({
      msg: 'catalog.category-admin-tree',
      code: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #read(
    context: CallContext,
    input: Record<string, never>,
  ): Promise<Result<CategoryAdminTreeOutput, CategoryAdminTreeFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const body = closedInput(input ?? {}, []);
    if (!body.ok) return body;
    const { market } = context;
    const { policy } = this.deps;
    const locales = policy.locales(market);
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        // One after the other: the unit holds one connection.
        const { adminCategoryReader } = this.deps;
        const nodes = await adminCategoryReader.categories(market, MAX_TREE_NODES + 1);
        const treeVersion = await adminCategoryReader.treeVersion(market);
        const counted = await adminCategoryReader.productFacts(market, CATEGORY_COUNT_BUDGET_MS);
        return ok({ nodes, treeVersion, counted });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const { nodes, treeVersion, counted } = read.value;
    let rows;
    try {
      rows = adminCategoryTree(nodes, locales.default, counted.facts);
    } catch (error) {
      if (error instanceof CategoryTreeUnavailableError) {
        return err({ code: 'catalog.categories-unavailable' });
      }
      throw error;
    }
    return ok({
      treeVersion,
      defaultLocale: locales.default,
      supportedLocales: [...locales.supported],
      requiredLocales: [...requiredCategoryLocales(market, policy)],
      complete: counted.complete,
      categories: rows.map(rowViewOf),
      actions: await categoryActions(context, this.deps.categoryProbes, null),
    });
  }
}
