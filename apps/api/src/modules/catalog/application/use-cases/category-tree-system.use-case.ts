import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  readCategoryTree,
  type CategoryTreeAnswer,
  type CategoryTreeDependencies,
  type CategoryTreeFailure,
} from './category-tree.use-case';

/**
 * `catalog.category-tree-system`: the same live platform category tree for the system actor
 * (search's event handlers and rebuild run as the system actor, which the `anonymous` rule of
 * `catalog.category-tree` never admits; identity design 6.2 row 1). Same read, same answer, so a
 * system caller learns nothing a buyer cannot. In-process only, never over HTTP.
 */
export class CategoryTreeSystemQuery extends UseCase<
  Record<string, never>,
  CategoryTreeAnswer,
  CategoryTreeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-tree-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryTreeDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Promise<Result<CategoryTreeAnswer, CategoryTreeFailure>> {
    return readCategoryTree(this.deps, context);
  }
}
