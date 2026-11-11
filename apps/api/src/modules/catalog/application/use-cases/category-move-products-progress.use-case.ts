import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_CATEGORY_TREE_VIEW } from '../../contracts/permissions';
import {
  categoryIdOf,
  closedInput,
  type ValidationFailure,
} from '../categories/category-admin-views';
import type { CategoryProductMoveStore, MoveProgress } from '../ports/category-product-move.store';

export interface CategoryMoveProductsProgressInput {
  readonly [key: string]: unknown;
}

const LATEST_JOBS = 5;

export interface CategoryMoveProductsProgressOutput {
  /** The newest jobs of the category, newest first; the dialog shows the first. */
  readonly jobs: readonly MoveProgress[];
}

export type CategoryMoveProductsProgressFailure =
  ValidationFailure | { readonly code: 'access.denied' } | { readonly code: 'category.not-found' };

/**
 * `platform-category.move-products-progress`: the state and counts of the newest jobs that move
 * the products of a category (queued, running, done, failed; total, moved, skipped, failed).
 * Codes, ids and numbers only: no reason note and no seller. Rule: `catalog.category-tree.view`.
 */
export class CategoryMoveProductsProgress extends UseCase<
  CategoryMoveProductsProgressInput,
  CategoryMoveProductsProgressOutput,
  CategoryMoveProductsProgressFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-move-products-progress',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: {
      readonly unitOfWork: UnitOfWork;
      readonly moveStore: CategoryProductMoveStore;
    },
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryMoveProductsProgressInput,
  ): Promise<Result<CategoryMoveProductsProgressOutput, CategoryMoveProductsProgressFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const body = closedInput(input, ['categoryId'] as const);
    if (!body.ok) return body;
    const id = categoryIdOf(body.value['categoryId']);
    if (!id.ok) return id;
    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.moveStore.listForSource(market, id.value, LATEST_JOBS)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'category.not-found' });
    return ok({
      jobs: read.value.map((job) => ({
        id: job.id,
        sourceCategoryId: job.sourceCategoryId,
        targetCategoryId: job.targetCategoryId,
        state: job.state,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        total: job.total,
        moved: job.moved,
        skipped: job.skipped,
        failed: job.failed,
      })),
    });
  }
}
