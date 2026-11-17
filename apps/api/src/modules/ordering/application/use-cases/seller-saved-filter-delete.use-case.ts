import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SELLER_ORDER_VIEW } from '../../contracts/permissions';
import {
  deleteSavedFilter,
  type SavedFilterDeleteFailure,
  type SavedFilterDeleteOutput,
} from '../saved-views/saved-view-operations';
import type { SavedViewDependencies } from '../saved-views/saved-view-shared';

/**
 * `ordering.seller-saved-filter-delete`: Deletes a saved filter of the seller order list for good.
 */
export class SellerSavedFilterDelete extends UseCase<
  unknown,
  SavedFilterDeleteOutput,
  SavedFilterDeleteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-saved-filter-delete',
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
  ): Promise<Result<SavedFilterDeleteOutput, SavedFilterDeleteFailure>> {
    return deleteSavedFilter(this.deps, 'seller', context, input);
  }
}
