import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { categoryImpact, type CategoryImpactCounts } from '../../domain/category-admin-tree';
import { CategoryTreeUnavailableError, MAX_TREE_NODES } from '../../domain/category-tree';
import { CATALOG_CATEGORY_TREE_VIEW } from '../../contracts/permissions';
import {
  CATEGORY_COUNT_BUDGET_MS,
  categoryIdOf,
  closedInput,
  invalid,
  type ValidationFailure,
} from '../categories/category-admin-views';
import type { AdminCategoryReader } from '../ports/admin-category.reader';

export const CATEGORY_IMPACT_ACTIONS = ['move', 'merge', 'archive'] as const;
export type CategoryImpactAction = (typeof CATEGORY_IMPACT_ACTIONS)[number];

export interface CategoryImpactInput {
  readonly categoryId: unknown;
  readonly action?: unknown;
}

export interface CategoryImpactOutput extends CategoryImpactCounts {
  readonly action: CategoryImpactAction;
  /** False when the time bound ran out: every count is then "at least". */
  readonly complete: boolean;
}

export type CategoryImpactFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'category.not-found' }
  | { readonly code: 'catalog.categories-unavailable' }
  | ValidationFailure;

export interface CategoryImpactDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly adminCategoryReader: AdminCategoryReader;
}

/**
 * `platform-category.impact` (catalog design 9.2a; categories package C1): what a move, a merge or
 * an archive of a category would touch: published products in its subtree, their Offers, the listed
 * Offers and those with an active certification tag. Advisory: a change sends nothing from it and
 * re-checks its own guards. Bounded at 10 seconds, then `complete` is false. Rule: the key
 * `catalog.category-tree.view` (the design's `catalog.product.view` is replaced by the new view
 * key, plan section 11) and the admin population.
 */
export class CategoryImpact extends UseCase<
  CategoryImpactInput,
  CategoryImpactOutput,
  CategoryImpactFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-impact',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_VIEW.key] },
  };

  readonly #logger = new Logger('CategoryImpact');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryImpactDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryImpactInput,
  ): Promise<Result<CategoryImpactOutput, CategoryImpactFailure>> {
    const result = await this.#read(context, input);
    this.#logger.log({
      msg: 'catalog.category-impact',
      code: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #read(
    context: CallContext,
    input: CategoryImpactInput,
  ): Promise<Result<CategoryImpactOutput, CategoryImpactFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const body = closedInput(input, ['categoryId', 'action']);
    if (!body.ok) return body;
    const id = categoryIdOf(body.value['categoryId']);
    if (!id.ok) return id;
    const rawAction = body.value['action'];
    if (
      typeof rawAction !== 'string' ||
      !(CATEGORY_IMPACT_ACTIONS as readonly string[]).includes(rawAction)
    ) {
      return invalid('action', rawAction === undefined ? 'required' : 'unknown');
    }
    const action = rawAction as CategoryImpactAction;
    const { market } = context;
    const { adminCategoryReader } = this.deps;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const nodes = await adminCategoryReader.categories(market, MAX_TREE_NODES + 1);
        if (!nodes.some((node) => node.id === id.value)) return ok(null);
        const counted = await adminCategoryReader.productFacts(market, CATEGORY_COUNT_BUDGET_MS);
        return ok({ nodes, counted });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'category.not-found' });
    try {
      const counts = categoryImpact(read.value.nodes, id.value, read.value.counted.facts);
      return ok({ ...counts, action, complete: read.value.counted.complete });
    } catch (error) {
      if (error instanceof CategoryTreeUnavailableError) {
        return err({ code: 'catalog.categories-unavailable' });
      }
      throw error;
    }
  }
}
