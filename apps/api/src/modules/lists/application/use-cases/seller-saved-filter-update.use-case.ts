import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SavedFilterView } from '../saved-filter-shared';
import {
  handleSavedFilterUpdate,
  type SavedFilterUpdateDependencies,
  type SavedFilterUpdateFailure,
  type SavedFilterUpdateInput,
} from './saved-filter-update.use-case';

/**
 * `lists.seller-saved-filter-update`: `saved-filter-update` for a seller list (super list B0-1b, seller
 * side). The rules, caps, audit and permission checks are those of the admin use case, run for the
 * `seller` population: the caller must be a seller session with a store, an acting-as (Login as
 * Seller) session is refused, a store-scoped list keeps its rows per store and an account-scoped
 * one per seller account. Open to a seller whose store is not yet approved, like the seller routes
 * it replaces: the panel is usable while onboarding.
 */
export class SellerSavedFilterUpdate extends UseCase<
  SavedFilterUpdateInput,
  SavedFilterView,
  SavedFilterUpdateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'lists.seller-saved-filter-update',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SavedFilterUpdateDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: SavedFilterUpdateInput,
  ): Promise<Result<SavedFilterView, SavedFilterUpdateFailure>> {
    return handleSavedFilterUpdate('seller', this.deps, context, input);
  }
}
