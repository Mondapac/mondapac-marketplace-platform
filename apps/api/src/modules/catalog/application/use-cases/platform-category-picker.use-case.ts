import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_PLATFORM_PRODUCT_EDIT } from '../../contracts/permissions';
import {
  readPicker,
  type CategoryPickerAnswer,
  type CategoryPickerDependencies,
  type CategoryPickerFailure,
} from '../categories/category-picker-read';

/**
 * `platform-product.category-picker`: the same read for the admin platform product form; hidden
 * nodes are offered too (a PLATFORM product may sit on a hidden category). Rule: the key
 * `catalog.platform-product.edit`.
 */
export class PlatformCategoryPicker extends UseCase<
  Record<string, never>,
  CategoryPickerAnswer,
  CategoryPickerFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-category-picker',
    rule: { kind: 'permissions', allOf: [CATALOG_PLATFORM_PRODUCT_EDIT.key] },
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
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return Promise.resolve(err({ code: 'access.denied' }));
    }
    return readPicker(this.deps, context, true);
  }
}

export type { CategoryPickerAnswer, CategoryPickerFailure };
