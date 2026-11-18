import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SavedFilterView } from '../saved-filter-shared';
import {
  handleSavedFilterCreate,
  type SavedFilterCreateDependencies,
  type SavedFilterCreateFailure,
  type SavedFilterCreateInput,
} from './saved-filter-create.use-case';

/**
 * `lists.seller-saved-filter-create`: `saved-filter-create` for a seller list (super list B0-1b, seller
 * side). The rules, caps, audit and permission checks are those of the admin use case, run for the
 * `seller` population: the caller must be a seller session with a store, an acting-as (Login as
 * Seller) session is refused, a store-scoped list keeps its rows per store and an account-scoped
 * one per seller account. Open to a seller whose store is not yet approved, like the seller routes
 * it replaces: the panel is usable while onboarding.
 */
export class SellerSavedFilterCreate extends UseCase<
  SavedFilterCreateInput,
  SavedFilterView,
  SavedFilterCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'lists.seller-saved-filter-create',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SavedFilterCreateDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: SavedFilterCreateInput,
  ): Promise<Result<SavedFilterView, SavedFilterCreateFailure>> {
    return handleSavedFilterCreate('seller', this.deps, context, input);
  }
}
