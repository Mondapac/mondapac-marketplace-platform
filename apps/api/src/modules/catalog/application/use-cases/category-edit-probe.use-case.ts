import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_CATEGORY_TREE_EDIT } from '../../contracts/permissions';
import {
  adminOnly,
  type CategoryProbeAnswer,
  type CategoryProbeFailure,
} from '../categories/category-probe';

/** Whether the caller holds `catalog.category-tree.edit`. */
export class CategoryEditProbe extends UseCase<
  Record<string, never>,
  CategoryProbeAnswer,
  CategoryProbeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-edit-probe',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_EDIT.key] },
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(
    context: CallContext,
  ): Promise<Result<CategoryProbeAnswer, CategoryProbeFailure>> {
    return Promise.resolve(adminOnly(context));
  }
}
