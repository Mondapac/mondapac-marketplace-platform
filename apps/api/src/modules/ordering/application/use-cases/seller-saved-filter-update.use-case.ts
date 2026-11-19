import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SELLER_ORDER_VIEW } from '../../contracts/permissions';
import {
  updateSavedFilter,
  type SavedFilterUpdateFailure,
} from '../saved-views/saved-view-operations';
import type { SavedFilterView, SavedViewDependencies } from '../saved-views/saved-view-shared';

/**
 * `ordering.seller-saved-filter-update`: Renames a saved filter of the seller order list; only the owner can see it, so another account's filter is `saved-filter.not-found`.
 */
export class SellerSavedFilterUpdate extends UseCase<
  unknown,
  SavedFilterView,
  SavedFilterUpdateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-saved-filter-update',
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
  ): Promise<Result<SavedFilterView, SavedFilterUpdateFailure>> {
    return updateSavedFilter(this.deps, 'seller', context, input);
  }
}
