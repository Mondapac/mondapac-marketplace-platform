import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SELLER_ORDER_VIEW } from '../../contracts/permissions';
import {
  listSavedFilters,
  type SavedFiltersListFailure,
  type SavedFiltersListOutput,
} from '../saved-views/saved-view-operations';
import type { SavedViewDependencies } from '../saved-views/saved-view-shared';

/**
 * `ordering.seller-saved-filters-list`: The saved views of the seller order list that the caller owns (a seller filter is never shared). Rule: `ordering.seller-order.view`; the population is seller.
 */
export class SellerSavedFiltersList extends UseCase<
  unknown,
  SavedFiltersListOutput,
  SavedFiltersListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-saved-filters-list',
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
  ): Promise<Result<SavedFiltersListOutput, SavedFiltersListFailure>> {
    return listSavedFilters(this.deps, 'seller', context, input);
  }
}
