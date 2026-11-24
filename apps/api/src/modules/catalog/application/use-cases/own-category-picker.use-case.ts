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
import type { SellerCategoryScope } from '../business-activities/allowed-category-ids';

export interface OwnCategoryPickerDependencies extends CategoryPickerDependencies {
  /** The seller's activity scope: only categories inside it are offered. */
  readonly sellerCategories: Pick<SellerCategoryScope, 'allowedCategoryIdsForSeller'>;
}

/**
 * `own-product.category-picker` (categories package C5a): the choices of the seller product
 * form's "Categories and tax" card. Levels 3 and 4 only, children first and the level-3 node
 * itself as "General" when it has children; hidden nodes (and anything under one) are not
 * offered to a seller. Only the categories of the seller's business activities are offered
 * (`allowedCategoryIdsForSeller`); a seller whose activities allow none gets no choice and the
 * notice `no-activity`, and a scope that cannot be read is `catalog.categories-unavailable` (fail
 * closed, never the whole tree). Rule: the key `catalog.own-product.edit`, as the form that uses it.
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
    private readonly deps: OwnCategoryPickerDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<CategoryPickerAnswer, CategoryPickerFailure>> {
    const { actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    // Asked before the picker's unit: the scope opens units of its own (units do not nest).
    const allowed = await this.deps.sellerCategories.allowedCategoryIdsForSeller(
      context,
      actor.sellerId,
    );
    if (!allowed.ok) return err({ code: 'catalog.categories-unavailable' });
    return readPicker(this.deps, context, false, allowed.value);
  }
}

export type { CategoryPickerAnswer, CategoryPickerFailure };
