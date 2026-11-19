import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SELLER_ORDER_VIEW } from '../../contracts/permissions';
import {
  createSavedFilter,
  type SavedFilterCreateFailure,
} from '../saved-views/saved-view-operations';
import type { SavedFilterView, SavedViewDependencies } from '../saved-views/saved-view-shared';

/**
 * `ordering.seller-saved-filter-create`: Saves the tab, days and sort of the seller order list under a name, for the caller only (`everyone` is refused). Same caps and name rules as the admin list.
 */
export class SellerSavedFilterCreate extends UseCase<
  unknown,
  SavedFilterView,
  SavedFilterCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-saved-filter-create',
    rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SavedViewDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<SavedFilterView, SavedFilterCreateFailure>> {
    return createSavedFilter(this.deps, 'seller', context, input);
  }
}
