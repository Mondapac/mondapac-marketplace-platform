import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import {
  readPicker,
  type CategoryPickerAnswer,
  type CategoryPickerDependencies,
  type CategoryPickerFailure,
} from '../categories/category-picker-read';

/**
 * `own-product.category-picker` (categories package C5a): the choices of the seller product
 * form's "Categories and tax" card. Levels 3 and 4 only, children first and the level-3 node
 * itself as "General" when it has children; hidden nodes (and anything under one) are not
 * offered to a seller. Rule: the key `catalog.own-product.edit`, as the form that uses it.
 */
export class OwnCategoryPicker extends UseCase<
  Record<string, never>,
  CategoryPickerAnswer,
  CategoryPickerFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-category-picker',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryPickerDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
  ): Promise<Result<CategoryPickerAnswer, CategoryPickerFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'seller') {
      return Promise.resolve(err({ code: 'access.denied' }));
    }
    return readPicker(this.deps, context, false);
  }
}

export type { CategoryPickerAnswer, CategoryPickerFailure };
